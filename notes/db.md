# volatile db and ledger state ideas

in order from the most adapt to the job to the less.

## lmdb

https://github.com/kriszyp/lmdb-js

according to the readme, it should keep support for both node and bun

https://chatgpt.com/share/67b27772-0c18-8004-8f0a-bb89f263389e

## pebbleDB

This seemed like a reasonable alternative, but there are no bindings

sligtly less efficient in reads than lmdb, BUT, has WAY less impact on the RAM.

configurable `cacheSize` would automatially handle quick "hot utxos" lookup (eg. DeFi contracts ref scripts utxos).

https://chatgpt.com/share/67b33582-adbc-8004-826b-c17c891735a3

## SQLite ??? (consider carefully, probably slow and overkill)
for the database, especially volatile db and ledger state,
the ideal thing to do would be to use indexedDb in the browser
and a shim of indexedDb maybe wrapping SQLite in node/bun (possibly using native SQLite api if in bun)

here is a potential approach: https://stackoverflow.com/a/78085160
