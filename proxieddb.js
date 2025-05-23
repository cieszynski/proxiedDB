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

                                    const store = db.createObjectStore(
                                        dbName, {
                                        keyPath: keypath.replace(/[\+@]/, ''),
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

                            const request = db
                                .transaction(storeName, ['add', 'put', 'delete'].includes(verb)
                                    ? 'readwrite'
                                    : 'readonly')
                                .objectStore(storeName)
                            [verb](...args);
                            request.onerror = () => reject(request.error);
                            request.onsuccess = () => {
                                resolve(request.result);
                            };

                            db.close();
                        } catch (err) { reject(err); }
                    });
                }

                // executeOr('delete', indexName, keyRange [, indexName, keyRange, ...])
                // executeOr('query', indexName, keyRange [, indexName, keyRange, ...])
                // executeOr('update', indexName, keyRange [, indexName, keyRange, ...], payLoad)
                const executeOr = (verb, ...args) => {
                    console.assert(['delete', 'update', 'query'].includes(verb));
                    console.assert(args.length && (
                        (['delete', 'query'].includes(verb) && ((args.length % 2) === 0)) ||
                        (['update'].includes(verb) && (((args.length + 1) % 2) === 0))
                    ));

                    // ensures unique entries
                    const unique = new class extends Array {
                        push(obj) {
                            // Objects are only stringified the same, Set() won't work
                            if (!this.some(entry => JSON.stringify(entry) === JSON.stringify(obj))) {
                                super.push(obj);
                            }
                        }
                    }

                    const results = {
                        delete: [0],
                        update: unique,
                        query: unique
                    }

                    const result = results[verb];

                    // updateOr: last argument is the payload
                    const payLoad = ('update' === verb)
                        ? args.pop()
                        : undefined;

                    const executeOr_delete = (cursor) => {
                        cursor
                            .delete()
                            // increment number of deleted records
                            .onsuccess = () => { result[0]++; }
                    }

                    const executeOr_query = (cursor) => {
                        // add the found record
                        result.push(cursor.value)
                    }

                    const executeOr_update = (cursor) => {
                        // only {} records reach this, so we can merge
                        cursor
                            .update(Object.assign(cursor.value, payLoad))
                            .onsuccess = (event) => {
                                // add the key of the updated record
                                result.push(event.target.result);
                            };
                    }

                    return new Promise(async (resolve, reject) => {
                        try {
                            const db = await connect(dbName);

                            const transaction = db
                                .transaction(storeName, ['update', 'delete'].includes(verb)
                                    ? 'readwrite'
                                    : 'readonly');
                            transaction.onerror = () => reject(request.error);
                            transaction.oncomplete = () => {
                                resolve(result);
                                db.close();
                            }

                            const store = transaction.objectStore(storeName);

                            while (args.length) {
                                const indexName = args.shift();
                                const keyRange = args.shift();

                                if (!Array.from(store.indexNames).includes(indexName)) {
                                    return reject(new DOMException(
                                        `object store "${storeName}" index "${indexName}" was not found`,
                                        "NotFoundError"
                                    ));
                                }

                                const request = store
                                    .index(indexName)
                                    .openCursor(keyRange);
                                request.onsuccess = () => {
                                    const cursor = request.result;

                                    if (cursor) {
                                        switch (verb) {
                                            case 'delete':
                                                executeOr_delete(cursor);
                                                break;

                                            case 'update':
                                                executeOr_update(cursor);
                                                break;

                                            case 'query':
                                                executeOr_query(cursor);
                                                break;

                                            default:
                                                return reject(new DOMException(
                                                    `verb "${verb}" was not supported`,
                                                    "NotSupportedError"
                                                ));
                                        }

                                        cursor.continue();
                                    }
                                };
                            } // END while
                        } catch (err) {
                            reject(err);
                        }
                    }); // END return new Promise
                }

                return self = Object.freeze({
                    add(obj, key) { return execute('add', obj, key); },

                    count(keyOrKeyRange) { return execute('count', keyOrKeyRange); },

                    delete(keyOrKeyRange) { return execute('delete', keyOrKeyRange); },

                    get(keyOrKeyRange) { return execute('get', keyOrKeyRange); },

                    getKey(keyOrKeyRange) { return execute('getKey', keyOrKeyRange); },

                    getAll(keyRange, limit) { return execute('getAll', keyRange, limit); },

                    getAllKeys(keyRange, limit) { return execute('getAllKeys', keyRange, limit); },

                    put(obj, key) { return execute('put', obj, key); },

                    where(indexName, keyRange, direction) {
                        return new Promise(async (resolve, reject) => {
                            try {
                                const db = await connect(dbName);

                                const result = []; // must be outside of 'request.onsuccess = ()'
                                const request = db
                                    .transaction(storeName)
                                    .objectStore(storeName)
                                    .index(indexName)
                                    .openCursor(keyRange, direction);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = () => {
                                    const cursor = request.result;
                                    if (cursor) {
                                        result.push(cursor.value);
                                        cursor.continue();
                                    } else {
                                        resolve(result);
                                    }
                                };

                                db.close();

                            } catch (err) {
                                reject(err);
                            }
                        });
                    },
                    updateOr(...args) { return executeOr('update', ...args) },
                    deleteOr(...args) { return executeOr('delete', ...args) },
                    queryOr(...args) { return executeOr('query', ...args) },
                    and(...args) {
                        console.assert(args.length && !(args.length % 2));

                        const result = [];
                        const indexName = args.shift();
                        const keyRange = args.shift();

                        return new Promise(async (resolve, reject) => {
                            try {
                                const db = await connect(dbName);

                                const request = db
                                    .transaction(storeName)
                                    .objectStore(storeName)
                                    .index(indexName)
                                    .openCursor(keyRange);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = (event) => {
                                    const cursor = event.target.result;

                                    if (cursor) {

                                        // check more conditions
                                        // to fullfill every condition must passed
                                        while (args.length) {
                                            const indexName = args.shift();
                                            const keyRange = args.shift();

                                            if (!keyRange.includes(cursor.value[indexName])) {
                                                cursor.continue();
                                                return;
                                            }
                                        }

                                        result.push(cursor.value);

                                        cursor.continue();
                                    } else {
                                        resolve(result);
                                    }
                                }
                            } catch (err) {
                                reject(err);
                            }
                        }); // END return new Promise
                    }, // END and(...args)
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
                    deletes(indexName, keyOrKeyRange) {

                        let result = 0;

                        return new Promise(async (resolve, reject) => {
                            try {
                                const db = await connect(dbName);

                                const request = db
                                    .transaction(storeName, 'readwrite')
                                    .objectStore(storeName)
                                    .index(indexName)
                                    .openCursor(keyOrKeyRange);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = (event) => {
                                    const cursor = event.target.result;

                                    if (cursor) {
                                        cursor
                                            .delete()
                                            .onsuccess = () => { result++; }

                                        cursor.continue();
                                    } else {
                                        resolve(result);
                                        db.close();
                                    }
                                }
                            } catch (err) {
                                reject(err);
                            }
                        }); // END return new Promise
                    }
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