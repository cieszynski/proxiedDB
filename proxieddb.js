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
                    return new Promise((resolve, reject) => {
                        connect(dbName)
                            .then(db => {
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
                    });
                }

                return Object.freeze({
                    add(obj, key) { return execute('add', obj, key); },

                    count(keyOrKeyRange) { return execute('count', keyOrKeyRange); },

                    delete(keyOrKeyRange) { return execute('delete', keyOrKeyRange); },

                    get(keyOrKeyRange) { return execute('get', keyOrKeyRange); },

                    getKey(keyOrKeyRange) { return execute('getKey', keyOrKeyRange); },

                    getAll(keyRange, limit) { return execute('getAll', keyRange, limit); },

                    getAllKeys(keyRange, limit) { return execute('getAllKeys', keyRange, limit); },

                    put(obj, key) { return execute('put', obj, key); },

                    where(indexName, keyRange, direction) {
                        return new Promise((resolve, reject) => {
                            connect(dbName)
                                .then(db => {
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
                                })
                        });
                    },
                    query(indexName, keyRange) {
                        // ensures unique entries
                        const result = new class extends Array {
                            push(obj) {
                                // Objects are only stringified the same
                                if (!this.some(entry => JSON.stringify(entry) === JSON.stringify(obj))) {
                                    super.push(obj)
                                }
                            }
                        }

                        const orArray = [{ indexName: indexName, keyRange: keyRange }];
                        const andArray = [{ indexName: indexName, keyRange: keyRange }];

                        return new class {

                            and(indexName, keyRange) {
                                console.assert(orArray.length <= 1)
                                andArray.push({ indexName: indexName, keyRange: keyRange });
                                return this;
                            }

                            or(indexName, keyRange) {
                                console.assert(andArray.length <= 1)
                                orArray.push({ indexName: indexName, keyRange: keyRange });
                                return this;
                            }

                            toArray() {
                                return new Promise((resolve, reject) => {
                                    connect(dbName)
                                        .then(db => {
                                            if (Array.from(db.objectStoreNames).includes(storeName)) {
                                                let ready = 0;
                                                const done = () => {
                                                    if (++ready === orArray.length) {
                                                        resolve(result)
                                                    }
                                                }
                                                const store = db
                                                    .transaction(storeName)
                                                    .objectStore(storeName)

                                                if (andArray.length > 1) {
                                                    const first = andArray.shift();
                                                    const request = store
                                                        .index(first.indexName)
                                                        .openCursor(first.keyRange);
                                                    request.onerror = () => reject(request.error);
                                                    request.onsuccess = () => {
                                                        const cursor = request.result;
                                                        if (cursor) {

                                                            // check more conditions
                                                            // to fullfill every condition must passed
                                                            if (andArray.every(entry => entry.keyRange.includes(
                                                                cursor.value[entry.indexName]))
                                                            ) {
                                                                result.push(cursor.value)
                                                            }

                                                            cursor.continue();
                                                        } else {
                                                            resolve(result)
                                                        }
                                                    }
                                                }

                                                if (orArray.length > 1) {
                                                    orArray.forEach(entry => {
                                                        const request = store
                                                            .index(entry.indexName)
                                                            .openCursor(entry.keyRange);
                                                        request.onerror = () => reject(request.error);
                                                        request.onsuccess = () => {
                                                            const cursor = request.result;
                                                            if (cursor) {
                                                                result.push(cursor.value)
                                                                cursor.continue();
                                                            } else {
                                                                done();
                                                            }
                                                        };
                                                    })
                                                }
                                            } else {
                                                reject('not toArray')
                                            }
                                        })
                                });
                            } // END toArray
                        } // END return new class
                    }, // END query
                    and(...arguments) {
                        console.assert(arguments.length && !(arguments.length % 2));

                        const result = [];
                        const indexName = arguments.shift();
                        const keyRange = arguments.shift();

                        return new Promise((resolve, reject) => {
                            const onsuccess = (event) => {
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
                                    resolve(result)
                                }
                            }

                            connect(dbName)
                                .then(db => {
                                    const request = db
                                        .transaction(storeName)
                                        .objectStore(storeName)
                                        .index(indexName)
                                        .openCursor(keyRange);
                                    request.onerror = () => reject(request.error);
                                    request.onsuccess = onsuccess;
                                });
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

                        return new Promise((resolve, reject) => {

                            connect(dbName)
                                .then(db => {
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
                                                    resolve(result)
                                                }
                                            }
                                        };
                                    } // END while
                                });
                        }); // END return new Promise
                    } // END or(...arguments)
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
                    return 'next'
                case 'DESC':
                    return 'prev'
            }
        }
    })
});