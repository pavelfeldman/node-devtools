#!/usr/bin/env node

// Usage:
// - launch adapter:
//   $ node server.js
// - run node in debug mode:
//   $ node --debug -e "setInterval(function(){console.log('ping');},1000)"
// - open dev tools:
//   chrome-devtools://devtools/bundled/devtools.html?ws=localhost:9800/localhost:5858
// - helpful debugging:
//   eval:
//     InspectorBackendClass.Options.dumpInspectorProtocolMessages = true

var net = require('net');
var optimist = require('optimist');
var readline = require('readline');
var url = require('url');
var ws = require('ws');

var Promise = require('es6-promise').Promise;

var argv = optimist
    .usage('Usage: $0 --port [num]')
    .options('p', {
      describe: 'Port the adapter will listen on for DevTools connections.',
      alias: 'port',
      default: 9800
    })
    .argv;
if (argv.help) {
  optimist.showHelp();
  return;
}

console.log('node-devtools adapter starting...');
console.log('  Listening for DevTools on localhost:' + argv['port']);

// Setup socket server to listen for DevTools connections.
var devToolsServer = new ws.Server({
  port: argv['port']
});
devToolsServer.on('connection', function(devToolsSocket) {
  // Pause the socket so that we don't lose any messages.
  devToolsSocket.pause();

  // url should be something like /localhost:5222
  var parsedUrl = url.parse(devToolsSocket.upgradeReq.url);
  var endpoint = parsedUrl.path.substring(1);
  var host = endpoint.substring(0, endpoint.indexOf(':'));
  var port = Number(endpoint.substring(host.length + 1));

  // We open the target before we start handling messages, so that we can ensure
  // both can talk to each other right away.
  console.log('DevToolsConnection opening target ' + endpoint + '...');
  var targetSocket = net.connect({
    host: host,
    port: port
  });
  targetSocket.on('connect', function() {
    var connection = new DevToolsConnection(
        devToolsSocket, targetSocket, endpoint);
    openDevToolsConnections.push(connection);
  });
  targetSocket.on('error', function(e) {
    console.error('Unable to connect to target at ' + endpoint, e);
    devToolsSocket.close();
  });
});

/**
 * All open connections to DevTools instances.
 * @type {!Array.<!DevToolsConnection>}
 */
var openDevToolsConnections = [];

/**
 * A connection to a DevTools instance.
 * @param {!ws.WebSocket} devToolsSocket DevTools web socket.
 * @param {!ws.WebSocket} targetSocket Target web socket.
 * @param {string} endpoint Target endpoint like 'localhost:5222'.
 * @constructor
 */
var DevToolsConnection = function(devToolsSocket, targetSocket, endpoint) {
  this.devTools_ = devToolsSocket;
  this.target_ = targetSocket;
  this.endpoint_ = endpoint;

  /**
   * Whether the connection has been closed.
   * @type {boolean}
   * @private
   */
  this.closed_ = false;

  /**
   * Next sequence ID to use for the target command channel.
   * @type {number}
   * @private
   */
  this.nextTargetSeqId_ = 0;

  /**
   * Pending map of sequence IDs to Promises for the target command channel.
   * @type {!Object.<number, !{resolve: Function, reject: Function}>}
   * @private
   */
  this.pendingTargetPromises_ = {};

  /**
   * Incoming target string buffer, used to accumulate data until we have a
   * full message to dispatch.
   * @type {string}
   * @private
   */
  this.targetBuffer_ = '';

  /**
   * Dispatch table that matches methods from the DevTools.
   * For example, 'Debugger.enable' -> fn that handles the message.
   * Each function receives the params, if present, and the resolve/reject
   * functions for a promise that responds to the message.
   * @type {!Object.<function(Object, Function, Function)>}
   * @private
   */
  this.devToolsDispatch_ = this.buildDevToolsDispatch_();

  /**
   * Dispatch table that matches events from the target.
   * For example, 'break' -> fn that handles the message.
   * Each function receives the body of the event, if present.
   * @type {!Object.<function(Object)>}
   * @private
   */
  this.targetDispatch_ = this.buildTargetDispatch_();

  // DevTools socket.
  this.devTools_.on('message', (function(data, flags) {
    this.processDevToolsMessage_(data);
  }).bind(this));
  this.devTools_.on('error', (function(e) {
    console.log('DevTools::error', e);
  }).bind(this));
  this.devTools_.on('close', (function() {
    this.close();
  }).bind(this));

  // Target socket.
  this.target_.setEncoding('utf8');
  this.target_.setKeepAlive(true);
  this.target_.on('data', (function(data, flags) {
    this.processTargetMessage_(data);
  }).bind(this));
  this.target_.on('error', (function(e) {
    console.log('Target::error', e);
    this.close();
  }).bind(this));
  this.target_.on('close', (function() {
    this.close();
  }).bind(this));

  // Resume the devtools socket so that we get messages.
  this.devTools_.resume();
};

/**
 * Processes an incoming DevTools message.
 * @param {string} data Incoming data.
 * @private
 */
DevToolsConnection.prototype.processDevToolsMessage_ = function(data) {
  console.log('[DT]', data);

  var packet = JSON.parse(data);
  var method = packet['method'];
  if (method) {
    var reqId = packet['id'];
    var dispatchMethod = this.devToolsDispatch_[method];
    if (!dispatchMethod) {
      console.error('Unhandled DevTools message: ' + method);
      // TODO(pfeldman): proper error response?
      this.devTools_.send(JSON.stringify({
        'id': reqId,
        'error': 'Unknown?'
      }));
      return;
    }
    var params = packet['params'] || {};
    var promise = new Promise(function(resolve, reject) {
      dispatchMethod(params, resolve, reject);
    });
    promise.then((function(response) {
      this.devTools_.send(JSON.stringify({
        'id': reqId,
        'result': response
      }));
    }).bind(this), (function(err) {
      // TODO(pfeldman): proper error response?
      this.devTools_.send(JSON.stringify({
        'id': reqId,
        'error': err.toString()
      }));
    }).bind(this));
  } else {
    // TODO(pfeldman): anything that isn't a method?
    console.error('Unknown DevTools message: ' + packet);
  }
};

/**
 * Sends a command to the DevTools.
 * @param {string} method Method, such as 'Debugger.paused'.
 * @param {Object} params Parameters, if any.
 * @private
 */
DevToolsConnection.prototype.sendDevToolsCommand_ = function(method, params) {
  this.devTools_.send(JSON.stringify({
    'method': method,
    'params': params
  }));
};

/**
 * Processes an incoming target message.
 * @param {string} data Incoming data.
 * @private
 */
DevToolsConnection.prototype.processTargetMessage_ = function(data) {
  this.targetBuffer_ += data;

  // Run a pass over the buffer. If we can parse a complete message, dispatch
  // it.
  while (this.targetBuffer_.length) {
    if (!attemptProcessing.call(this)) {
      break;
    }
  }

  function attemptProcessing() {
    // Read headers.
    var headers = {};
    var offset = 0;
    while (offset < this.targetBuffer_.length) {
      var linefeed = this.targetBuffer_.indexOf('\n', offset);
      if (linefeed == -1) {
        return false;
      }
      var line = this.targetBuffer_.substring(offset, linefeed).trim();
      offset = linefeed + 1;
      if (line.length) {
        var parts = line.split(':');
        var key = parts[0].trim();
        var value = parts[1].trim();
        headers[key] = value;
      } else {
        // Empty line. Check for content.
        var contentLength = Number(headers['Content-Length']) || 0;
        if (!contentLength) {
          // No content, done.
          this.dispatchTargetMessage_(headers, null);
          this.targetBuffer_ = this.targetBuffer_.substring(offset);
          return true;
        } else {
          if (this.targetBuffer_.length - offset >= contentLength) {
            // Content present.
            this.dispatchTargetMessage_(
                headers, this.targetBuffer_.substr(offset, contentLength));
            this.targetBuffer_ = this.targetBuffer_.substring(offset);
            return true;
          }
        }
      }
    }
    return false;
  };
};

/**
 * Processes an incoming target message.
 * @param {!Object.<string, string>} headers HTTP-ish headers.
 * @param {string?} content Content string, if any.
 * @private
 */
DevToolsConnection.prototype.dispatchTargetMessage_ = function(
    headers, content) {
  if (!content) {
    // ?
    return;
  }

  console.log('[V8]', content);

  var packet = JSON.parse(content);
  switch (packet['type']) {
    case 'response':
      var promisePair = this.pendingTargetPromises_[packet['request_seq']];
      if (packet['success']) {
        promisePair.resolve(packet['body']);
      } else {
        promisePair.reject(Error(packet['message'] || 'Unknown error'));
      }
      break;
    case 'event':
      var dispatchMethod = this.targetDispatch_[packet['event']];
      if (!dispatchMethod) {
        console.error('Unknown target event: ' + packet['event']);
        return;
      }
      dispatchMethod(packet['body'] || {});
      break;
    default:
      console.error('Unknown target packet type: ' + packet['type']);
      break;
  }
};

/**
 * Sends a command to the target.
 * @param {string} command Command name, like 'continue'.
 * @param {Object} args Command arguments object, if any.
 * @return Promise satisfied when a response is received.
 * @private
 */
DevToolsConnection.prototype.sendTargetCommand_ = function(command, args) {
  // Construct packet object.
  var packet = {
    'seq': ++this.nextTargetSeqId_,
    'type': 'request',
    'command': command
  };
  if (args) {
    packet['arguments'] = args;
  }

  // Stash promise.
  var promise = new Promise((function(resolve, reject) {
    this.pendingTargetPromises_[packet['seq']] = {
      resolve: resolve,
      reject: reject
    };
  }).bind(this));

  // Send the data.
  var packetString = JSON.stringify(packet);
  var packetLength = packetString.length;
  this.target_.write(
      'Content-Length: ' + packetLength + '\r\n\r\n' +
      packetString);

  return promise;
};

/**
 * Closes the connection to the DevTools and target.
 */
DevToolsConnection.prototype.close = function() {
  if (this.closed_) {
    return;
  }
  this.closed_ = true;

  // Close target connection.
  // This will allow the target to resume running.
  this.target_.destroy();

  // Close DevTools connection.
  this.devTools_.close();

  // Remove from open connection list.
  openDevToolsConnections.splice(openDevToolsConnections.indexOf(this), 1);

  console.log('DevToolsConnection closing');
};

/**
 * Builds the dispatch table that maps incoming DevTools commands to actions.
 * @return {!Object.<function(Object, Function, Function)>} Lookup table.
 * @private
 */
DevToolsConnection.prototype.buildDevToolsDispatch_ = function() {
  var lookup = {};

  //----------------------------------------------------------------------------
  // Console.*
  //----------------------------------------------------------------------------

  lookup['Console.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': true });
  }).bind(this);
  lookup['Console.clearMessages'] = (function(params, resolve, reject) {
    resolve({});
  }).bind(this);

  //----------------------------------------------------------------------------
  // CSS.*
  //----------------------------------------------------------------------------

  lookup['CSS.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Database.*
  //----------------------------------------------------------------------------

  lookup['Database.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Debugger.*
  //----------------------------------------------------------------------------

  lookup['Debugger.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': true });
  }).bind(this);
  lookup['Debugger.setOverlayMessage'] = (function(params, resolve, reject) {
    if (params['message']) {
      console.log('Debugger: ' + params['message']);
    }
    resolve();
  }).bind(this);

  lookup['Debugger.setAsyncCallStackDepth'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);
  lookup['Debugger.setPauseOnExceptions'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
    var type;
    var enabled;
    switch (params['state']) {
      case 'all':
        type = 'all';
        enabled = true;
        break;
      case 'none':
        type = 'all';
        enabled = false;
        break;
      case 'uncaught':
        type = 'uncaught';
        enabled = true;
        break;
      default:
        reject(Error('Unknown setPauseOnExceptions state: ' + params['state']));
        return;
    }
    this.sendTargetCommand_('setexceptionbreak', {
      'type': type,
      'enabled': enabled
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.setSkipAllPauses'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Debugger.pause'] = (function(params, resolve, reject) {
    // NOTE: this eval will not respond immediately!
    // We'll need to resolve() right away and poke the DevTools to let them know
    // the (probably) succeeded.
    // TODO(pfeldman): I'm sure there's some InjectedScript thing for this.
    this.sendTargetCommand_('evaluate', {
      'expression': 'debugger',
      'global': true
    });
    resolve();
    this.sendDevToolsCommand_('Debugger.paused', {
      'callFrames': [],
      'reason': 'debugCommand',
      'data': {}
    });
  }).bind(this);
  lookup['Debugger.resume'] = (function(params, resolve, reject) {
    this.sendTargetCommand_('continue').then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.stepInto'] = (function(params, resolve, reject) {
    this.sendTargetCommand_('continue', {
      'stepaction': 'in',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.stepOut'] = (function(params, resolve, reject) {
    this.sendTargetCommand_('continue', {
      'stepaction': 'out',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.stepOver'] = (function(params, resolve, reject) {
    this.sendTargetCommand_('continue', {
      'stepaction': 'over',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);

  //----------------------------------------------------------------------------
  // DOMStorage.*
  //----------------------------------------------------------------------------

  lookup['DOMStorage.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // HeapProfiler.*
  //----------------------------------------------------------------------------

  lookup['HeapProfiler.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Inspector.*
  //----------------------------------------------------------------------------

  lookup['Inspector.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Network.*
  //----------------------------------------------------------------------------

  lookup['Network.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Network.setCacheDisabled'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Page.*
  //----------------------------------------------------------------------------

  lookup['Page.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Page.canScreencast'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Page.getResourceTree'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Page.setShowViewportSizeOnResize'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Profiler.*
  //----------------------------------------------------------------------------

  lookup['Profiler.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Runtime.*
  //----------------------------------------------------------------------------

  lookup['Runtime.evaluate'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  lookup['Runtime.releaseObjectGroup'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Timeline.*
  //----------------------------------------------------------------------------

  lookup['Timeline.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  //----------------------------------------------------------------------------
  // Worker.*
  //----------------------------------------------------------------------------

  lookup['Worker.canInspectWorkers'] = (function(params, resolve, reject) {
    resolve({ 'result': false });
  }).bind(this);

  return lookup;
};

/**
 * Builds the dispatch table that maps incoming target events to actions.
 * @return {!Object.<function(Object)>} Lookup table.
 * @private
 */
DevToolsConnection.prototype.buildTargetDispatch_ = function() {
  var lookup = {};

  lookup['break'] = (function(body) {
    // TODO(pfeldman): pull out args and switch - 'breakpoints' has a list
    //     of breakpoints that could be used.
    this.sendDevToolsCommand_('Debugger.paused', {
      'callFrames': [],
      'reason': 'debugCommand',
      'data': {}
    });
  }).bind(this);

  lookup['exception'] = (function(body) {
    // TODO(pfeldman): what is 'data'? exception info? uncaught flag?
    console.log('TODO: incoming target exception event');
    this.sendDevToolsCommand_('Debugger.paused', {
      'callFrames': [],
      'reason': 'exception',
      'data': {}
    });
  }).bind(this);

  return lookup;
};
