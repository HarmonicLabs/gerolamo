# volatile db ideas

for the database, especially volatile db and ledger state,
the ideal thing to do would be to use indexedDb in the browser
and a shim of indexedDb maybe wrapping SQLite in node/bun (possibly using native SQLite api if in bun)

here is a potential approach: https://stackoverflow.com/a/78085160