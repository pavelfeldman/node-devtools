// Copyright (c) 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var util = require('util');

var EventEmitter = require('events').EventEmitter;
var Promise = require('es6-promise').Promise;

/**
 * A facade around the target debug agent.
 * @param {!net.Socket} targetSocket Target TCP socket.
 * @param {string} endpoint Target endpoint like 'localhost:5858'.
 * @param {!Object} argv Command line arguments.
 * @constructor
 */
var DebugTarget = function(targetSocket, endpoint, argv) {
  /**
   * TCP socket connection to the target debugger instance.
   * @type {!net.Socket}
   * @private
   */
  this.targetSocket_ = targetSocket;

  /**
   * Target endpoint address (like 'localhost:5858').
   * @type {string}
   * @private
   */
  this.endpoint_ = endpoint;

  /**
   * Command line arguments.
   * @type {!Object}
   * @private
   */
  this.argv_ = argv;

  /**
   * Whether the connection has been closed.
   * @type {boolean}
   * @private
   */
  this.closed_ = false;

  /**
   * Target V8 information.
   * This is populated on connect and the values will be undefined until then.
   * @type {!DebugTarget.TargetInfo}
   * @private
   */
  this.targetInfo_ = {
    host: 'unknown',
    isNode: false,
    v8: '0'
  };

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

  // Target socket.
  this.targetSocket_.setEncoding('utf8');
  this.targetSocket_.setKeepAlive(true);
  this.targetSocket_.on('data', (function(data, flags) {
    this.processTargetMessage_(data);
  }).bind(this));
  this.targetSocket_.on('error', (function(err) {
    this.emit('error', err);
    this.close();
  }).bind(this));
  this.targetSocket_.on('close', (function() {
    this.close();
  }).bind(this));
};
util.inherits(DebugTarget, EventEmitter);

/**
 * @typedef {
 *   host: string,
 *   isNode: boolean,
 *   v8: string
 * }
 */
DebugTarget.TargetInfo;

/**
 * Processes an incoming target message.
 * @param {string} data Incoming data.
 * @private
 */
DebugTarget.prototype.processTargetMessage_ = function(data) {
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
            this.targetBuffer_ = this.targetBuffer_.substring(offset + contentLength);
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
DebugTarget.prototype.dispatchTargetMessage_ = function(headers, content) {
  if (!content) {
    if (headers['Type'] == 'connect') {
      this.targetInfo_ = {
        host: headers['Embedding-Host'],
        isNode: headers['Embedding-Host'].indexOf('node') == 0,
        v8: headers['V8-Version']
      };
      this.emit('connect', this.targetInfo_);
    }
    return;
  }

  if (this.argv_['log-network']) {
    console.log('[V8->]', content);
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
    case 'event':
      this.emit('event', packet['event'], packet['body'] || {});
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
DebugTarget.prototype.sendCommand = function(command, args) {
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
  this.targetSocket_.write(
      'Content-Length: ' + packetLength + '\r\n\r\n' +
      packetString);

  if (this.argv_['log-network']) {
    console.log('[->V8]', packetString);
  }

  return promise;
};

/**
 * Closes the connection to the DevTools and target.
 */
DebugTarget.prototype.close = function() {
  if (this.closed_) {
    return;
  }
  this.closed_ = true;

  // Close target connection.
  // This will allow the target to resume running.
  this.targetSocket_.destroy();

  this.emit('close');
};

exports.DebugTarget = DebugTarget;
