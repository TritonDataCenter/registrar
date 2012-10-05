export PATH=$PWD/build/node/bin:$PWD/node_modules/.bin:$PATH

alias run='node main.js -f ./etc/config.json -v 2>&1 | bunyan'
