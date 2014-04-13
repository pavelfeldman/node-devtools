#!/usr/bin/env node
//
// Copyright (c) 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var net = require('net');
var optimist = require('optimist');
var readline = require('readline');
var url = require('url');
var util = require('util');
var ws = require('ws');

var EventEmitter = require('events').EventEmitter;
var Promise = require('es6-promise').Promise;
var DebugTarget = require('./debug_target.js').DebugTarget;

var argv = optimist
    .usage([
      'Usage: $0 --port [num]',
      '',
      'Acts as a relay between the Chrome DevTools and V8 debug agents (like',
      'node.js --debug). Supports multiple sessions at the same time; you only',
      'need one running.',
      '',
      'Example:',
      '  $ $0 --port=9800 &',
      '  $ node --debug=5858 -e "setInterval(function(){console.log(\'ping\');},1000)"',
      'Then open, open Chrome and visit:',
      '  chrome-devtools://devtools/bundled/devtools.html?ws=localhost:9800/localhost:5858',
      ''
    ].join('\n'))
    .options('p', {
      describe: 'Port the adapter will listen on for DevTools connections.',
      alias: 'port',
      default: 9800
    })
    .options('l', {
      describe: 'Log network traffic between the DevTools and the target.',
      alias: 'log-network',
      default: false
    })
    .argv;
if (argv.help) {
  optimist.showHelp();
  return;
}

console.log('node-devtools adapter listening on localhost:' + argv['port']);
console.log('Open the Chrome DevTools and connect to your debug target:');
console.log('');
console.log('  chrome-devtools://devtools/bundled/devtools.html?ws=localhost:' + argv['port'] + '/localhost:<port>');
console.log('');

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
  console.log('DevTools requesting relay to target at ' + endpoint + '...');
  var targetSocket = net.connect({
    host: host,
    port: port
  });
  targetSocket.on('connect', function() {
    // Create and stash connection.
    var debugTarget = new DebugTarget(targetSocket, endpoint, argv);
    var relay = new Relay(devToolsSocket, debugTarget);
    openRelays.push(relay);

    debugTarget.on('connect', function(targetInfo) {
      console.log('Connected to \'' + this.endpoint_ + '\':');
      console.log('  Host: ' + targetInfo.host);
      console.log('    V8: ' + targetInfo.v8);
      console.log('');

      // Resume the socket so that messages come through.
      devToolsSocket.resume();
    });
    relay.on('error', function(err) {
      console.error('Relay error:', err);
    });
    relay.on('close', function() {
      console.log('Relay to ' + endpoint + ' closed.');
      console.log('');
    });
  });
  targetSocket.on('error', function(err) {
    console.error('Unable to connect to target at ' + endpoint, err);
    console.log('');
    devToolsSocket.close();
  });
});

/**
 * All open relays.
 * @type {!Array.<!Relay>}
 */
var openRelays = [];

/**
 * A relay between a DevTools session and a target debug agent.
 * @param {!ws.WebSocket} devToolsSocket DevTools web socket.
 * @param {!DebugTarget} debugTarget
 * @constructor
 */
var Relay = function(devToolsSocket, debugTarget) {
  /**
   * WebSocket connection to the DevTools instance.
   * @type {!ws.WebSocket}
   * @private
   */
  this.devTools_ = devToolsSocket;

  /**
   * Debug target instance.
   * @type {!DebugTarget}
   * @private
   */
  this.debugTarget_ = debugTarget;

  /**
   * Whether the connection has been closed.
   * @type {boolean}
   * @private
   */
  this.closed_ = false;

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
  this.devTools_.on('error', (function(err) {
    console.log('DevTools::error', err);
    this.emit('error', err);
  }).bind(this));
  this.devTools_.on('close', (function() {
    this.close();
  }).bind(this));

  this.debugTarget_.on('error', (function(err) {
    console.log('Target::error', err);
    this.emit('error', err);
    this.close();
  }).bind(this));
  this.debugTarget_.on('close', (function() {
    this.close();
  }).bind(this));
  this.debugTarget_.on('event', (function(event, body) {
    var dispatchMethod = this.targetDispatch_[event];
    if (!dispatchMethod) {
      console.error('Unknown target event: ' + event);
      return;
    }
    dispatchMethod(body);
  }).bind(this));
};
util.inherits(Relay, EventEmitter);

/**
 * Processes an incoming DevTools message.
 * @param {string} data Incoming data.
 * @private
 */
Relay.prototype.processDevToolsMessage_ = function(data) {
  if (argv['log-network']) {
    console.log('[DT->]', data);
  }

  var packet = JSON.parse(data);
  var method = packet['method'];
  if (method) {
    var reqId = packet['id'];
    var dispatchMethod = this.devToolsDispatch_[method];
    if (!dispatchMethod) {
      console.error('Unhandled DevTools message: ' + method);
      // TODO(pfeldman): proper error response?
      var responseData = JSON.stringify({
        'id': reqId,
        'error': 'Unknown?'
      });
      this.devTools_.send(responseData);
      if (argv['log-network']) {
        console.log('[->DT]', responseData);
      }
      return;
    }
    var params = packet['params'] || {};
    var promise = new Promise(function(resolve, reject) {
      dispatchMethod(params, resolve, reject);
    });
    promise.then((function(response) {
      var responseData = JSON.stringify({
        'id': reqId,
        'result': response
      });
      this.devTools_.send(responseData);
      if (argv['log-network']) {
        console.log('[->DT]', responseData);
      }
    }).bind(this), (function(err) {
      // TODO(pfeldman): proper error response?
      var responseData = JSON.stringify({
        'id': reqId,
        'error': err.toString()
      });
      this.devTools_.send(responseData);
      if (argv['log-network']) {
        console.log('[->DT]', responseData);
      }
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
Relay.prototype.sendDevToolsCommand_ = function(method, params) {
  var data = JSON.stringify({
    'method': method,
    'params': params
  });
  this.devTools_.send(data);

  if (argv['log-network']) {
    console.log('[->DT]', data);
  }
};

/**
 * Closes the connection to the DevTools and target.
 */
Relay.prototype.close = function() {
  if (this.closed_) {
    return;
  }
  this.closed_ = true;

  // Close target.
  // This will allow the target to resume running.
  this.debugTarget_.close();

  // Close DevTools connection.
  this.devTools_.close();

  // Remove from open connection list.
  openRelays.splice(openRelays.indexOf(this), 1);

  this.emit('close');
};

/**
 * Builds the dispatch table that maps incoming DevTools commands to actions.
 * @return {!Object.<function(Object, Function, Function)>} Lookup table.
 * @private
 */
Relay.prototype.buildDevToolsDispatch_ = function() {
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
  // DebugTarget.*
  //----------------------------------------------------------------------------

  lookup['Debugger.enable'] = (function(params, resolve, reject) {
    resolve({ 'result': true });
  }).bind(this);
  lookup['Debugger.setOverlayMessage'] = (function(params, resolve, reject) {
    if (params['message']) {
      console.log('DebugTarget: ' + params['message']);
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
    this.debugTarget_.sendCommand('setexceptionbreak', {
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
    this.debugTarget_.sendCommand('evaluate', {
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
    this.debugTarget_.sendCommand('continue').then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.stepInto'] = (function(params, resolve, reject) {
    this.debugTarget_.sendCommand('continue', {
      'stepaction': 'in',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.stepOut'] = (function(params, resolve, reject) {
    this.debugTarget_.sendCommand('continue', {
      'stepaction': 'out',
      'stepcount': 1
    }).then(function(response) { resolve(); }, reject);
  }).bind(this);
  lookup['Debugger.stepOver'] = (function(params, resolve, reject) {
    this.debugTarget_.sendCommand('continue', {
      'stepaction': 'next',
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
Relay.prototype.buildTargetDispatch_ = function() {
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
