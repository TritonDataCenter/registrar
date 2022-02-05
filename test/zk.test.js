/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2022 Joyent, Inc.
 */

var net = require('net');
var path = require('path');

var test = require('tape');
var uuid = require('node-uuid');

var helper = require('./helper');
var registrar = require('../lib');



///--- Globals

var CLIENT;



///--- Tests

test('error with down ZK (and abort)', function (t) {
    var opts = {
        connectTimeout: 10,
        log: helper.log,
        servers: [
            {
                host: '127.0.0.1',
                port: 2182
            }
        ]
    };
    var status = registrar.createZKClient(opts, function (err, client) {
        t.ok(err);
        t.notOk(client);
        t.end();
    });

    status.on('attempt', function (num) {
        if (num === 2)
            status.stop();
    });
});


test('start zk client', function (t) {
    var opts = {
        log: helper.log,
        servers: [helper.zkServer]
    };
    registrar.createZKClient(opts, function (err, client) {
        t.ifError(err);
        t.ok(client);
        t.equal(typeof (client.heartbeat), 'function');
        client.on('close', function teardown() {
            process.exit();
        });
        client.close(function (err2) {
            t.ifError(err2);
            t.end();
        });
    });
});