// Copyright 2014 Joyent, Inc. All rights reserved.

var net = require('net');
var path = require('path');

var test = require('tape');
var uuid = require('node-uuid');

var helper = require('./helper');
var registrar = require('../lib');



///--- Tests

test('setup', function (t) {
    helper.createZkClient(t);
});


test('healthcheck: create ok', function (t) {
    var check = registrar.createHealthCheck({
        command: '/usr/bin/true',
        log: helper.log,
        zk: helper.zkClient
    });

    t.ok(check);

    check.once('end', function () {
        t.end();
    });

    check.once('data', function (obj) {
        t.ok(obj);
        t.deepEqual({
            type: 'ok',
            command: '/usr/bin/true'
        }, obj);
        check.stop();
    });

    check.start();
});



test('healthcheck: create ok, ignore exit status', function (t) {
    var check = registrar.createHealthCheck({
        command: '/usr/bin/false',
        ignoreExitStatus: true,
        log: helper.log,
        zk: helper.zkClient
    });

    t.ok(check);

    check.once('end', function () {
        t.end();
    });

    check.once('data', function (obj) {
        t.ok(obj);
        t.deepEqual({
            type: 'ok',
            command: '/usr/bin/false'
        }, obj);
        check.stop();
    });

    check.start();
});


test('healthcheck: create fail check', function (t) {
    var check = registrar.createHealthCheck({
        command: '/usr/bin/false',
        log: helper.log,
        zk: helper.zkClient
    });

    t.ok(check);

    check.once('end', function () {
        t.end();
    });

    check.once('data', function (obj) {
        t.ok(obj);
        t.ok(obj.err);
        if (obj.err)
            delete obj.err;
        t.deepEqual({
            type: 'fail',
            command: '/usr/bin/false',
            failures: 1,
            isDown: false,
            threshold: 5
        }, obj);
        check.stop();
    });

    check.start();
});


test('healthcheck: create fail check by timeout', function (t) {
    var check = registrar.createHealthCheck({
        command: 'sleep 2; /usr/bin/true',
        log: helper.log,
        timeout: 10,
        zk: helper.zkClient
    });

    t.ok(check);

    check.once('end', function () {
        t.end();
    });

    check.once('data', function (obj) {
        t.ok(obj);
        t.ok(obj.err);
        if (obj.err)
            delete obj.err;
        t.deepEqual({
            type: 'fail',
            command: 'sleep 2; /usr/bin/true',
            failures: 1,
            isDown: false,
            threshold: 5
        }, obj);
        check.stop();
    });

    check.start();
});


test('healthcheck: create fail check by stdout', function (t) {
    var check = registrar.createHealthCheck({
        command: 'echo "hello, world"',
        log: helper.log,
        stdoutMatch: {
            pattern: 'hello, !(.*)'
        },
        zk: helper.zkClient
    });

    t.ok(check);

    check.once('end', function () {
        t.end();
    });

    check.once('data', function (obj) {
        t.ok(obj);
        t.ok(obj.err);
        if (obj.err)
            delete obj.err;
        t.deepEqual({
            type: 'fail',
            command: 'echo "hello, world"',
            failures: 1,
            isDown: false,
            threshold: 5
        }, obj);
        check.stop();
    });

    check.start();
});


test('healthcheck: create fail and mark down', function (t) {
    var check = registrar.createHealthCheck({
        command: '/usr/bin/false',
        interval: 5,
        log: helper.log,
        threshold: 3,
        zk: helper.zkClient
    });

    t.ok(check);

    check.once('end', function () {
        t.end();
    });

    var count = 0;
    check.on('data', function (obj) {
        t.ok(obj);
        t.ok(obj.err);
        if (obj.err)
            delete obj.err;
        if (++count < 3) {
            t.deepEqual({
                type: 'fail',
                command: '/usr/bin/false',
                failures: count,
                isDown: false,
                threshold: 3
            }, obj);
        } else {
            t.deepEqual({
                type: 'fail',
                command: '/usr/bin/false',
                failures: count,
                isDown: true,
                threshold: 3
            }, obj);
            check.stop();
        }
    });

    check.start();
});


test('teardown', function (t) {
    helper.zkClient.close(function (err) {
        t.ifError(err);
        t.end();
    });
});
