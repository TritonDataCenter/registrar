// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');
var fs = require('fs');
var os = require('os');

var bunyan = require('bunyan');
var clone = require('clone');
var optimist = require('optimist');
var vasync = require('vasync');
var zkplus = require('zkplus');



///--- Globals

var ARGV = optimist.options({
        'd': {
                alias: 'debug',
                describe: 'debug level'
        },
        'f': {
                alias: 'file',
                demand: true,
                describe: 'configuration file'
        }
}).argv;

var CFG;

var LOG = bunyan.createLogger({
        level: ARGV.d ? (ARGV.d > 1 ? 'trace' : 'debug') : 'info',
        name: 'registrar',
        serializers: {
                err: bunyan.stdSerializers.err
        },
        src: ARGV.d ? true : false,
        stream: process.stdout
});

var ZK;



///--- Helpers

// domainToPath(1.moray.sds.joyent.com) => /com/joyent/sds/moray/1
function domainToPath(domain) {
        assert.ok(domain);
        return ('/' + domain.split('.').reverse().join('/'));
}


function address() {
        var ifaces = os.networkInterfaces();
        var addrs = Object.keys(ifaces).filter(function (k) {
                return (!ifaces[k][0].internal);
        }).map(function (k) {
                return (ifaces[k][0]);
        });

        return (addrs[0].address);
}


function readConfig() {
        if (!CFG) {
                CFG = JSON.parse(fs.readFileSync(ARGV.f, 'utf8'));
                LOG.info({config: CFG, file: ARGV.f}, 'Configuration loaded');
        }

        return (CFG);
}


function registerSelf(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        var cfg = opts.cfg;
        var domain = opts.cfg.domain;
        var log = opts.log;
        var hostname = os.hostname();
        var path = opts.path + '/' + hostname;
        var zk = opts.zk;

        log.debug({
                domain: domain,
                hostname: hostname,
                path: path
        }, 'registerSelf: entered');

        zk.mkdirp(opts.path, function (err) {
                if (err) {
                        log.error({
                                domain: domain,
                                hostname: hostname,
                                path: opts.path,
                                err: err
                        }, 'registerSelf: zk.mkdirp failed');
                        return (callback(err));
                }

                log.debug({
                        domain: domain,
                        hostname: hostname,
                        path: opts.path
                }, 'registerSelf: zk.mkdirp done');

                var options = {
                        flags: ['ephemeral'],
                        object: {
                                type: cfg.type
                        }
                };
                options.object[cfg.type] = {
                        address: address()
                };
                if (typeof (cfg.ttl) === 'number')
                        options.object.ttl = cfg.ttl;

                zk.creat(path, options, function (err2) {
                        if (err2 && err2.code !== zkplus.ZNODEEXISTS) {
                                log.error({
                                        domain: domain,
                                        hostname: hostname,
                                        path: path,
                                        err: err
                                }, 'registerSelf: zk.put failed');
                                return (callback(err2));
                        }

                        log.info({
                                domain: domain,
                                hostname: hostname,
                                path: path,
                                data: options
                        }, 'registerSelf: done');
                        return (callback(null));
                });
                return (undefined);
        });
}


function registerService(opts, callback) {
        assert.ok(opts);
        assert.ok(callback);

        if (!opts.cfg.service)
                return (callback());

        var cfg = opts.cfg;
        var domain = opts.cfg.domain;
        var log = opts.log;
        var path = opts.path;
        var zk = opts.zk;

        log.debug({
                domain: domain,
                path: path
        }, 'registerService: entered');

        var obj = {
                type: 'service',
                service: cfg.service
        };
        zk.update(path, obj, function (err) {
                if (err) {
                        log.error({
                                domain: domain,
                                path: path,
                                err: err
                        }, 'registerService: zk.update failed');
                } else {
                        log.debug({
                                domain: domain,
                                path: path
                        }, 'registerService: zk.update done');
                }

                callback(err || null);
        });

        return (undefined);
}



///--- Mainline

readConfig();
var zkOpts = clone(CFG.zookeeper);
zkOpts.log = LOG;

ZK = zkplus.createClient(zkOpts);
ZK.on('connect', function onConnect() {
        LOG.info({
                registration: CFG.registration,
                zk: CFG.zookeeper,
                path: domainToPath(CFG.registration.domain)
        }, 'ZooKeeper connection successful; registering.');

        // register $self in ZK depending on the type. We always
        // write a leadnode for ourselves, but we may need to additionally
        // set a service record.
        vasync.pipeline({
                arg: {
                        cfg: CFG.registration,
                        log: LOG,
                        path: domainToPath(CFG.registration.domain),
                        zk: ZK
                },
                funcs: [registerSelf, registerService]
        }, function (err) {
                if (err) {
                        LOG.fatal(err, 'Unable to register in ZooKeeper');
                        process.exit(1);
                }
        });
});

ZK.on('close', function () {
        LOG.fatal('ZooKeeper session closed; exiting');
        process.exit(1);
});

ZK.on('error', function (err) {
        LOG.fatal(err, 'ZooKeeper error event; exiting');
        process.exit(1);
});
