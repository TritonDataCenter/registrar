// Copyright (c) 2014, Joyent, Inc. All rights reserved.

var assert = require('assert-plus');
var backoff = require('backoff');
var once = require('once');
var vasync = require('vasync');
var zkplus = require('zkplus');



///-- API

function heartbeat(opts, cb) {
    assert.object(opts, 'options');
    assert.arrayOfString(opts.nodes, 'options.nodes');
    assert.optionalObject(opts.retry, 'options.retry');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    cb = once(cb);

    function check(_, _cb) {
        vasync.forEachParallel({
            func: opts.zk.stat.bind(opts.zk),
            inputs: opts.nodes
        }, _cb);
    }

    var retry = backoff.call(check, null, cb);
    retry.failAfter((opts.retry || {}).maxAttempts || 5);
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: (opts.retry || {}).initialDelay || 1000,
        maxDelay: (opts.retry || {}).maxDelay || 30000
    }));
    retry.start();
}


function patchClient(zk) {
    zk.heartbeat = function _heartbeat(opts, cb) {
        assert.object(opts, 'options');

        heartbeat({
            nodes: opts.nodes,
            retry: opts.retry,
            zk: zk
        }, cb);
    };

    return (zk);
}


function createZKClient(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.arrayOfObject(opts.servers, 'options.servers');
    assert.func(cb, 'callback');

    assert.ok((opts.servers.length > 0), 'options.servers empty');
    opts.servers.forEach(function (s) {
        assert.string(s.host, 'servers.host');
        assert.number(s.port, 'servers.port');
    });

    cb = once(cb);

    function create(_, _cb) {
        var client = zkplus.createClient(opts);
        client.connect(function (err) {
            if (err) {
                _cb(err);
            } else {
                _cb(null, patchClient(client));
            }
        });
    }

    var log = opts.log.child({component: 'zookeeper'}, true);
    var retry = backoff.call(create, null, function (err, client) {
        if (err) {
            log.fatal(err, 'createClient: unable to create ZK client');
            cb(err);
        } else {
            log.info('ZK: connected: %s', client.toString());
            cb(null, client);
        }
    });
    retry.failAfter(Infinity);
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: 1000,
        maxDelay: 90000
    }));
    setImmediate(retry.start.bind(retry));

    retry.on('backoff', function (number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        log[level]({
            attempt: number,
            delay: delay
        }, 'zookeeper: connection attempted (failed)');

        retry.emit('attempt', number, delay);
    });

    retry.stop = function () {
        retry.abort();
        cb(new Error('createZKClient: aborted'));
    };

    return (retry);
}



///--- Exports

module.exports = {
    createZKClient: createZKClient
};
