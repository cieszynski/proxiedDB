// MIT License

// Copyright (c) 2025 Stephan Cieszynski

Object.defineProperty(globalThis, 'proxiedDB', {
    value: new Proxy((dbName) => {

        return new Proxy({

            builder: (version) => {

                return {
                    build: (obj) => {

                        return new Promise((resolve, reject) => {

                            const request = indexedDB.open(dbName, version);
                            request.onerror = () => { reject(request.error); }
                            request.onblocked = () => { reject(request.error); }
                            request.onsuccess = () => {
                                request.result.close();
                                resolve('OK');
                            }
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
                                });
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
                            } else {
                                reject(Error(`Database '${dbName}' not found`));
                            }
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
                            if (arr.find(obj => obj.name === dbName)) {
                                const request = indexedDB.open(dbName);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = () => resolve(request.result);
                            } else {
                                reject(Error(`Database '${dbName}' not found`));
                            }
                        })
                });

                const execute = (verb, ...args) => {

                    return new Promise(async (resolve, reject) => {

                        const db = await connect(dbName);

                        if (Array.from(db.objectStoreNames).includes(storeName)) {
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
                        } else reject(Error(`Store '${storeName}' not found`));

                        db.close();
                    })
                        .catch(err => reject(err));
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

                            const db = await connect(dbName);

                            if (Array.from(db.objectStoreNames).includes(storeName)) {
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
                            } else reject(Error(`Store '${storeName}' not found`));

                            db.close();
                        });
                    },
                    and(...arguments) {
                        console.assert(arguments.length && !(arguments.length % 2));

                        const result = [];
                        const indexName = arguments.shift();
                        const keyRange = arguments.shift();

                        return new Promise(async (resolve, reject) => {

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
                                    while (arguments.length) {
                                        const indexName = arguments.shift();
                                        const keyRange = arguments.shift();

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
                        }); // END return new Promise
                    }, // END and(...arguments)
                    or(...arguments) {
                        console.assert(arguments.length && !(arguments.length % 2));

                        // ensures unique entries
                        const result = new class extends Array {
                            push(obj) {
                                // Objects are only stringified the same
                                if (!this.some(entry => JSON.stringify(entry) === JSON.stringify(obj))) {
                                    super.push(obj);
                                }
                            }
                        }

                        return new Promise(async (resolve, reject) => {
                            const db = await connect(dbName);
                            const store = db
                                .transaction(storeName)
                                .objectStore(storeName);

                            while (arguments.length) {
                                const indexName = arguments.shift();
                                const keyRange = arguments.shift();
                                const request = store
                                    .index(indexName)
                                    .openCursor(keyRange);
                                request.onerror = () => reject(request.error);
                                request.onsuccess = () => {
                                    const cursor = request.result;
                                    if (cursor) {
                                        result.push(cursor.value)
                                        cursor.continue();
                                    } else {
                                        if (!arguments.length) {
                                            resolve(result);
                                            db.close();
                                        }
                                    }
                                };
                            } // END while
                        }); // END return new Promise
                    }, // END or(...arguments)
                    ignoreCase(indexName, str, startsWith = false) {
                        console.assert(typeof str === 'string', 'ignoreCase: argument[1] no string');
                        console.assert(typeof indexName === 'string', 'ignoreCase: argument[0] no string');

                        let n = 0;
                        const result = [];
                        const permutations = [];

                        // Find all lowercase and uppercase
                        // combinations of a string
                        const permute = (str, tmp = '') => {
                            if (str.length == 0) {

                                // sort from ABC -> abc
                                permutations.unshift(tmp);
                            } else {
                                permute(str.substring(1), tmp + str[0].toLowerCase());
                                if (isNaN(str[0])) {
                                    permute(str.substring(1), tmp + str[0].toUpperCase());
                                }
                            }
                        }

                        permute(str);

                        return new Promise(async (resolve, reject) => {

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
                                        ? permutations[n].length
                                        : value.length;

                                    // find permutation > cursor.value[indexName]
                                    while (value.substring(0, length) > permutations[n]) {

                                        // there are no more permutations
                                        if (++n >= permutations.length) {
                                            resolve(result);
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
                                }
                            }
                        }); // END return new Promise
                    }, // END ignoreCase
                    // Syntactic sugar:
                    startsWith(indexName, str, direction) {
                        console.assert(typeof str === 'string', 'startsWith: argument[1] no string');
                        console.assert(typeof indexName === 'string', 'startsWith: argument[0] no string');

                        return self.where(indexName, proxiedDB.between(str, str + '|', true, true), direction);
                    },
                    startsWithIgnoreCase(indexName, str) {
                        console.assert(typeof str === 'string', 'startsWithIgnoreCase: argument[1] no string');
                        console.assert(typeof indexName === 'string', 'startsWithIgnoreCase: argument[0] no string');

                        return self.ignoreCase(indexName, str, true);
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