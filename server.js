#!/usr/bin/env node

// chrome-devtools://devtools/bundled/devtools.html?ws=localhost:9800/localhost:5858

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

  this.sendTargetCommand_('version', undefined).then(function(response) {
    console.log('response', response);
  }, function(err) {
    console.log('error', err);
  });
};

/**
 * Processes an incoming DevTools message.
 * @param {string} data Incoming data.
 * @private
 */
DevToolsConnection.prototype.processDevToolsMessage_ = function(data) {
  console.log(data);
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
    // event
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
DevToolsConnection.prototype.sendTargetCommand_ = function(
    command, args, opt_callback) {
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
