#!/usr/bin/env node

var optimist = require('optimist');
var argv = optimist
    .usage('Usage: $0 --listen-port [num] --target-port [num]')
    .options('p', {
      describe: 'Port the adapter will listen on for DevTools connections.',
      alias: 'listen-port',
      default: 9800
    })
    .options('t', {
      describe: 'Target port the adapter will connect to in node/v8.',
      alias: 'target-port',
      default: 5858
    })
    .argv;
if (argv.help) {
  optimist.showHelp();
  return;
}

console.log(argv);
