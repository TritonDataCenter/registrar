# registrar

Repository: <git@git.joyent.com:registrar.git>
Browsing: <https://mo.joyent.com/registrar>
Who: Mark Cavage
Docs: <https://mo.joyent.com/docs/registrar>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/MANTA>


# Overview

This repo contains `registar` the agent that registers a host with `binder`.

For more information see `docs/index.restdown`.

# Development

To run the registrar agent:

    make
	. ./env.sh
	run

Where you are assumed to have edited the config file as appropriate.

To update the guidelines, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

# Testing

This is an extremely small daemon.  There are no tests. You should just check
that ZK has your entry after the agent starts.
