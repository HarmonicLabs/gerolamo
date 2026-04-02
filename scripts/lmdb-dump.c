#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <lmdb.h>

static void hex_print(FILE *f, const unsigned char *data, size_t len) {
    for (size_t i = 0; i < len; i++)
        fprintf(f, "%02x", data[i]);
}

static void die(const char *msg, int rc) {
    fprintf(stderr, "%s: %s (%d)\n", msg, mdb_strerror(rc), rc);
    exit(1);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <lmdb-dir>\n", argv[0]);
        return 1;
    }

    MDB_env *env;
    MDB_txn *txn;
    MDB_dbi dbi, sub_dbi;
    MDB_cursor *cursor;
    MDB_val key, val;
    int rc;

    rc = mdb_env_create(&env);
    if (rc) die("mdb_env_create", rc);

    rc = mdb_env_set_mapsize(env, (size_t)2 * 1024 * 1024 * 1024);
    if (rc) die("mdb_env_set_mapsize", rc);

    rc = mdb_env_set_maxdbs(env, 10);
    if (rc) die("mdb_env_set_maxdbs", rc);

    rc = mdb_env_open(env, argv[1], MDB_RDONLY | MDB_NOTLS | MDB_NOLOCK, 0644);
    if (rc) die("mdb_env_open", rc);

    rc = mdb_txn_begin(env, NULL, MDB_RDONLY, &txn);
    if (rc) die("mdb_txn_begin", rc);

    /* Open root (unnamed) DB to list sub-databases */
    rc = mdb_dbi_open(txn, NULL, 0, &dbi);
    if (rc) die("mdb_dbi_open(root)", rc);

    rc = mdb_cursor_open(txn, dbi, &cursor);
    if (rc) die("mdb_cursor_open(root)", rc);

    /* Collect sub-database names */
    char *db_names[64];
    int db_count = 0;

    rc = mdb_cursor_get(cursor, &key, &val, MDB_FIRST);
    while (rc == 0 && db_count < 64) {
        db_names[db_count] = strndup(key.mv_data, key.mv_size);
        fprintf(stderr, "Found database: %s\n", db_names[db_count]);
        db_count++;
        rc = mdb_cursor_get(cursor, &key, &val, MDB_NEXT);
    }
    mdb_cursor_close(cursor);

    /* Iterate each sub-database */
    for (int d = 0; d < db_count; d++) {
        rc = mdb_dbi_open(txn, db_names[d], 0, &sub_dbi);
        if (rc) {
            fprintf(stderr, "mdb_dbi_open(%s): %s\n", db_names[d], mdb_strerror(rc));
            continue;
        }

        rc = mdb_cursor_open(txn, sub_dbi, &cursor);
        if (rc) {
            fprintf(stderr, "mdb_cursor_open(%s): %s\n", db_names[d], mdb_strerror(rc));
            continue;
        }

        long count = 0;
        rc = mdb_cursor_get(cursor, &key, &val, MDB_FIRST);
        while (rc == 0) {
            /* Output format: dbname\tkey_hex\tvalue_hex\n */
            printf("%s\t", db_names[d]);
            hex_print(stdout, key.mv_data, key.mv_size);
            putchar('\t');
            hex_print(stdout, val.mv_data, val.mv_size);
            putchar('\n');

            count++;
            if (count % 100000 == 0)
                fprintf(stderr, "  %s: %ld entries...\n", db_names[d], count);

            rc = mdb_cursor_get(cursor, &key, &val, MDB_NEXT);
        }
        mdb_cursor_close(cursor);
        fprintf(stderr, "  %s: %ld entries total\n", db_names[d], count);
        free(db_names[d]);
    }

    mdb_txn_abort(txn);
    mdb_env_close(env);
    return 0;
}
