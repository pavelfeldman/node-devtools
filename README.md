## How to demo

#### Install

```sh
$ npm install optimist --save-deps
$ npm install ws --save-deps
$ npm install es6-promise --save-deps
```

#### Run target script in node

```sh
$ node --debug example/myscript.js
```

#### Start debug bridge that listens on port 9800

```sh
$ node server.js
```

#### Debug

Point Chrome Canary to `chrome-devtools://devtools/bundled/devtools.html?ws=localhost:9800/localhost:5858` to start debugging.

Steps to demo:
 - Go to Sources panel
 - Press Cmd(Ctrl)+P to go to file, type `myscript.js`
 - Set a breakpoint at line 10
 - When stopped in the debugger, explore the stack to the right
 - In console evaluate `a`, `b` and `foo`
 - Continue execution
