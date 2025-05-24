// MIT License

// Copyright (c) 2025 Stephan Cieszynski

Object.defineProperty(globalThis, 'proxiedDB', {
    value: new Proxy((dbName) => {

        return new Proxy({

            builder: (version) => {

                return {
                    build: (obj) => {

                        return new Promise((resolve, reject) => {
                            let upgraded = false;

                            const request = indexedDB.open(dbName, version);
                            request.onerror = () => { reject(request.error); }
                            request.onblocked = () => { reject(request.error); }
                            request.onupgradeneeded = (event) => {
                                const db = request.result;

                                Object.entries(obj).forEach(([dbName, definition]) => {
                                    if (Array.from(db.objectStoreNames).includes(dbName)) {
                                        // TODO save data
                                        console.debug("store '%s' deleted", dbName);
                                        db.deleteObjectStore(dbName);
                                    }

                                    [keypath, ...indexes] = definition.split(/\s*(?:,)\s*/);

                                    const store = db.createObjectStore(dbName, {
                                        // if keyPath.length is 0 return undefined
                                        keyPath: keypath.replace(/[\+@]/, '') || undefined,
                                        autoIncrement: /^[\+@]/.test(keypath)
                                    });

                                    console.debug("store '%s' created", dbName);

                                    indexes.forEach(indexName => {

                                        store.createIndex(
                                            indexName.replace(/[\*!]/, ''),
                                            indexName
                                                .split(/\+/)
                                                // at this point every keypath is an array
                                                .map(elem => elem.replace(/[\*!]/, ''))
                                                .reduce((prev, cur, idx) => {
                                                    switch (idx) {
                                                        case 0:
                                                            // indexName is keyPath:
                                                            return cur;
                                                        case 1:
                                                            // indexName is compound key
                                                            return [prev, cur];
                                                        default:
                                                            return [...prev, cur];
                                                    }
                                                }),
                                            {
                                                multiEntry: /^\*/.test(indexName),
                                                unique: /^\!/.test(indexName)
                                            });


                                        console.debug("index '%s' created", indexName);
                                    })
                                    upgraded = true;
                                });
                            }
                            request.onsuccess = () => {
                                request.result.close();
                                resolve(upgraded);
                            }
                        });
                    }
                }
            },
            delete: () => {

                return new Promise((resolve, reject) => {

                    indexedDB.databases()
                        .then(arr => {
                            if (arr.find(obj => obj.name === dbName)) {
                                const request = indexedDB.deleteDatabase(dbName);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = () => resolve(request.result);
                            } else reject(new DOMException(
                                `database "${dbName}" was not found`,
                                "NotFoundError"
                            ));
                        });
                });
            }
        }, {
            get(target, storeName, proxy) {
                if (['builder', 'delete'].includes(storeName)) {
                    return Reflect.get(...arguments);
                }

                const connect = (dbName) => new Promise((resolve, reject) => {

                    indexedDB.databases()
                        .then(arr => {
                            // prevents the accidental creation of a new database
                            if (arr.find(obj => obj.name === dbName)) {
                                const request = indexedDB.open(dbName);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = () => {

                                    const db = request.result;

                                    // check, if the store exists
                                    if (!Array.from(db.objectStoreNames).includes(storeName)) {
                                        reject(new DOMException(
                                            `object store "${storeName}" was not found`,
                                            "NotFoundError"
                                        ));
                                    } else resolve(db);
                                };
                            } else {
                                reject(new DOMException(
                                    `database "${dbName}" was not found`,
                                    "NotFoundError"
                                ));
                            }
                        })
                });

                // Find all lowercase and uppercase
                // combinations of a string
                const permutation = (permutable) => {

                    const arr = [];
                    const permute = (str, tmp = '') => {
                        if (str.length == 0) {

                            arr.push(tmp);
                        } else {
                            permute(str.substring(1), tmp + str[0].toLowerCase());
                            if (isNaN(str[0])) {
                                permute(str.substring(1), tmp + str[0].toUpperCase());
                            }
                        }
                    }

                    permute(permutable);

                    // sort from ABC -> abc
                    return arr.sort();
                }

                const execute = (verb, ...args) => {

                    return new Promise(async (resolve, reject) => {
                        try {
                            const db = await connect(dbName);

                            const transaction = db
                                .transaction(storeName, /^(add|put|delete)$/.test(verb)
                                    ? 'readwrite'
                                    : 'readonly');
                            transaction.onerror = () => {
                                reject(transaction.error);
                                db.close();
                            }

                            const store = transaction.objectStore(storeName);
                            store[verb](...args).onsuccess = (event) => {
                                resolve(event.target.result);
                                db.close();
                            };
                        } catch (err) { reject(err); }
                    });
                }

                const execute_cursor_query = (cursor, result) => {
                    result.push(cursor.value);
                }

                const execute_cursor_update = (cursor, result, payload) => {
                    // only {} records reach this, so we can merge
                    cursor
                        .update(Object.assign(cursor.value, payload))
                        .onsuccess = (event) => {
                            // add the key of the updated record
                            result.push(event.target.result);
                        };
                }

                const execute_cursor_delete = (cursor, result) => {
                    cursor
                        .delete()
                        // increment number of deleted records
                        .onsuccess = () => { result[0]++; }
                }

                const execute_cursor_or = (event, verb, payload, result) => {
                    const cursor = event.target.result;

                    if (cursor) {
                        switch (verb) {
                            case 'query_or':
                                execute_cursor_query(cursor, result);
                                break;
                            case 'update_or':
                                execute_cursor_update(cursor, result, payload);
                                break;
                            case 'delete_or':
                                execute_cursor_delete(cursor, result);
                                break;

                            default:
                                return reject(new DOMException(
                                    `verb "${verb}" was not supported`,
                                    "NotSupportedError"
                                ));
                        }

                        cursor.continue();
                    }
                }

                const execute_cursor_and = (event, verb, args, payload, result) => {
                    const cursor = event.target.result;

                    if (cursor) {

                        // check more conditions
                        // to fullfill every condition must passed
                        for (let n = 0; n < args.length; n += 2) {
                            const indexName = args[n];
                            const keyRange = args[n + 1];

                            if (!keyRange.includes(cursor.value[indexName])) {
                                cursor.continue();
                                return;
                            }
                        }

                        switch (verb) {
                            case 'query_and':
                                execute_cursor_query(cursor, result);
                                break;
                            case 'update_and':
                                execute_cursor_update(cursor, result, payload);
                                break;
                            case 'delete_and':
                                execute_cursor_delete(cursor, result);
                                break;
                        }

                        cursor.continue();
                    }
                }

                const execute_transaction = (verb, ...args) => {

                    // ensures unique entries
                    const unique = new class extends Array {
                        push(obj) {
                            // Objects are only stringified the same, Set() won't work
                            if (!this.some(entry => JSON.stringify(entry) === JSON.stringify(obj))) {
                                super.push(obj);
                            }
                        }
                    }

                    const resultTypes = {
                        query_and: [],
                        update_and: [],
                        delete_and: [0],
                        query_or: unique,
                        update_or: unique,
                        delete_or: [0],
                        insert: [0]
                    }

                    const result = resultTypes[verb];

                    // update_[and|or]|insert: last argument is payload
                    const payload = /^(update|insert)/.test(verb)
                        ? args.pop()
                        : undefined;

                    return new Promise(async (resolve, reject) => {
                        try {
                            const db = await connect(dbName);

                            const transaction = db
                                .transaction(storeName, /^(update|delete|insert)/.test(verb)
                                    ? 'readwrite'
                                    : 'readonly');
                            transaction.onerror = () => {
                                reject(transaction.error);
                                db.close();
                            }
                            transaction.oncomplete = () => {
                                resolve(result);
                                db.close();
                            }

                            const store = transaction.objectStore(storeName);

                            switch (verb) {
                                case 'insert':
                                    payload.forEach(entry => {
                                        store.add(entry);
                                        result[0]++;
                                    })
                                    break;
                                case 'query_or':
                                case 'update_or':
                                case 'delete_or':
                                    while (args.length) {
                                        const indexName = args.shift();
                                        const keyRange = args.shift();

                                        const request = store
                                            .index(indexName)
                                            .openCursor(keyRange);
                                        request.onsuccess = (event) => {
                                            execute_cursor_or(event, verb, payload, result);
                                        }
                                    }
                                    break;
                                case 'query_and':
                                case 'update_and':
                                case 'delete_and':
                                    const indexName = args.shift();
                                    const keyRange = args.shift();

                                    const request = store
                                        .index(indexName)
                                        .openCursor(keyRange);
                                    request.onsuccess = (event) => {
                                        execute_cursor_and(event, verb, args, payload, result);
                                    }
                                    break;
                            }

                        } catch (err) {
                            reject(err);
                        }
                    });
                } // END executeAnd

                return Object.freeze({
                    add(obj, key) { return execute('add', obj, key); },

                    count(keyOrKeyRange) { return execute('count', keyOrKeyRange); },

                    delete(keyOrKeyRange) { return execute('delete', keyOrKeyRange); },

                    get(keyOrKeyRange) { return execute('get', keyOrKeyRange); },

                    getKey(keyOrKeyRange) { return execute('getKey', keyOrKeyRange); },

                    getAll(keyRange, limit) { return execute('getAll', keyRange, limit); },

                    getAllKeys(keyRange, limit) { return execute('getAllKeys', keyRange, limit); },

                    put(obj, key) { return execute('put', obj, key); },

                    where(indexName, keyRange, limit = 0, direction = 'next') {

                        const result = [];

                        return new Promise(async (resolve, reject) => {
                            try {
                                const db = await connect(dbName);

                                const transaction = db
                                    .transaction(storeName);
                                transaction.onerror = () => {
                                    reject(transaction.error);
                                    db.close();
                                }
                                transaction.oncomplete = () => {
                                    resolve(result);
                                    db.close();
                                }

                                const store = transaction.objectStore(storeName);

                                const request = store.index(indexName)
                                    .openCursor(keyRange, direction);
                                request.onsuccess = () => {
                                    const cursor = request.result;

                                    if (cursor) {
                                        result.push(cursor.value);

                                        if (!(limit && result.length >= limit)) {
                                            cursor.continue();
                                        }
                                    }
                                };

                                db.close();

                            } catch (err) {
                                reject(err);
                            }
                        });
                    },
                    queryOr(...args) { return execute_transaction('query_or', ...args) },
                    updateOr(...args) { return execute_transaction('update_or', ...args) },
                    deleteOr(...args) { return execute_transaction('delete_or', ...args) },
                    queryAnd(...args) { return execute_transaction('query_and', ...args) },
                    updateAnd(...args) { return execute_transaction('update_and', ...args) },
                    deleteAnd(...args) { return execute_transaction('delete_and', ...args) },
                    insert(arrOfObjects) { return execute_transaction('insert', arrOfObjects) },
                    ignoreCase(indexName, str, startsWith = false) {
                        console.assert(typeof str === 'string', 'ignoreCase: args[1] no string');
                        console.assert(typeof indexName === 'string', 'ignoreCase: args[0] no string');

                        let n = 0;
                        const result = [];
                        const permutations = permutation(str);

                        return new Promise(async (resolve, reject) => {
                            try {
                                const db = await connect(dbName);

                                const request = db
                                    .transaction(storeName)
                                    .objectStore(storeName)
                                    .index(indexName)
                                    .openCursor();
                                request.onerror = () => reject(request.error);
                                request.onsuccess = (event) => {
                                    const cursor = event.target.result;

                                    if (cursor) {

                                        const value = cursor.value[indexName];
                                        const length = startsWith
                                            ? permutations[0].length
                                            : value.length;

                                        // find cursor.value[indexName] > permutation
                                        while (value.substring(0, length) > permutations[n]) {

                                            // there are no more permutations
                                            if (++n >= permutations.length) {
                                                resolve(result);
                                                db.close();
                                                return;
                                            }
                                        }

                                        if ((startsWith && value.indexOf(permutations[n]) === 0)
                                            || value === permutations[n]) {

                                            result.push(cursor.value);
                                            cursor.continue();
                                        } else {
                                            cursor.continue(permutations[n]);
                                        }
                                    } else {
                                        resolve(result);
                                        db.close();
                                    }
                                }
                            } catch (err) {
                                reject(err);
                            }
                        }); // END return new Promise
                    }, // END ignoreCase
                }); // END return Object.freeze
            } // END get(target, storeName, proxy)
        });
    }, {
        get(target, property, proxy) {
            // static functions to build keyranges
            switch (property) {
                case 'eq':
                    return (z) => IDBKeyRange.only(z);
                case 'le':
                    return (y) => IDBKeyRange.upperBound(y);
                case 'lt':
                    return (y) => IDBKeyRange.upperBound(y, true);
                case 'ge':
                    return (x) => IDBKeyRange.lowerBound(x);
                case 'gt':
                    return (x) => IDBKeyRange.lowerBound(x, true);
                case 'between':
                    return (x, y, bx, by) => IDBKeyRange.bound(x, y, bx, by);
                case 'startsWith':
                    return (s) => IDBKeyRange.bound(s, s + '\uffff', true, true);
            }
            // static constants
            switch (property) {
                case 'ASC':
                    return 'next';
                case 'ASCUNIQUE':
                    return 'nextunique';
                case 'DESC':
                    return 'prev';
                case 'DESCUNIQUE':
                    return 'prevunique';
            }
        }
    })
});