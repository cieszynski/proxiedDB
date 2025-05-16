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

                    getAll(keyrange, limit) { return execute('getAll', keyrange, limit); },

                    getAllKeys(keyrange, limit) { return execute('getAllKeys', keyrange, limit); },

                    put(obj, key) { return execute('put', obj, key); },

                    where(indexName, keyrange, direction) {
                        return new Promise((resolve, reject) => {
                            connect(dbName)
                                .then(db => {
                                    if (Array.from(db.objectStoreNames).includes(storeName)) {
                                        const result = []; // must be outside of 'request.onsuccess = ()'
                                        const request = db
                                            .transaction(storeName)
                                            .objectStore(storeName)
                                            .index(indexName)
                                            .openCursor(keyrange, direction);
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
                    query(indexName, keyrange) {
                        // ensures unique entries
                        const resultSet = new Set();

                        const orArray = [{ indexName: indexName, keyrange: keyrange }];
                        const andArray = [{ indexName: indexName, keyrange: keyrange }];

                        return new class {

                            and(indexName, keyrange) {
                                console.assert(orArray.length <= 1)
                                andArray.push({ indexName: indexName, keyrange: keyrange });
                                return this;
                            }

                            or(indexName, keyrange) {
                                console.assert(andArray.length <= 1)
                                orArray.push({ indexName: indexName, keyrange: keyrange });
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
                                                        resolve(Array.from(resultSet))
                                                    }
                                                }
                                                const store = db
                                                    .transaction(storeName)
                                                    .objectStore(storeName)

                                                if (andArray.length > 1) {
                                                    const first = andArray.shift();
                                                    const request = store
                                                        .index(first.indexName)
                                                        .openCursor(first.keyrange);
                                                    request.onerror = () => reject(request.error);
                                                    request.onsuccess = () => {
                                                        const cursor = request.result;
                                                        if (cursor) {

                                                            // check more conditions
                                                            // to fullfill every condition must passed
                                                            if (andArray.every(entry => entry.keyrange.includes(
                                                                cursor.value[entry.indexName]))
                                                            ) {
                                                                resultSet.add(cursor.value);
                                                            }

                                                            cursor.continue();
                                                        } else {
                                                            resolve(Array.from(resultSet))
                                                        }
                                                    }
                                                }

                                                if (orArray.length > 1) {
                                                    orArray.forEach(entry => {
                                                        const request = store
                                                            .index(entry.indexName)
                                                            .openCursor(entry.keyrange);
                                                        request.onerror = () => reject(request.error);
                                                        request.onsuccess = () => {
                                                            const cursor = request.result;
                                                            if (cursor) {
                                                                resultSet.add(cursor.value);
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
                                })
                            }
                        }
                    }
                })
            }
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