# registrar

Repository: <git@git.joyent.com:registrar.git>
Browsing: <https://mo.joyent.com/registrar>
Who: Mark Cavage
Docs: <https://mo.joyent.com/docs/registrar>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/MANTA>


# Overview

This repo contains `registar` the agent that registers a host with `binder`.

For more information see `docs/index.restdown`.

# Repository

    deps/           Git submodules (node et al).
    docs/           Project docs (restdown)
    node_modules/   Node.js deps, populated at build time.
    smf/manifests   SMF manifests
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md


# Development

To run the registrar agent:

    git clone git@git.joyent.com:registrar.git
    cd registrar
    git submodule update --init
    make all
	. ./env.sh
    node main.js -f ./etc/registrar.laptop.json 2>&1 | bunyan

Where you are assumed to have edited the config file as appropriate.

To update the guidelines, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

# Testing

This is an extremely small daemon.  There are no tests. You should just check
that ZK has your entry after the agent starts.
