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

                    query(indexName, keyrange, direction) {
                        return new Promise((resolve, reject) => {
                            connect(dbName)
                                .then(db => {
                                    if (Array.from(db.objectStoreNames).includes(storeName)) {
                                        const request = db
                                            .transaction(storeName)
                                            .objectStore(storeName)
                                            .index(indexName)
                                            .openCursor(keyrange, direction);
                                        request.onerror = () => reject(request.error);
                                        request.onsuccess = () => {
                                            const cursor = request.result;
                                            const result = [];

                                            if(cursor) {
                                                console.log(cursor.value);
                                                result.push(cursor.value);
                                                cursor.continue();

                                            }
                                            resolve(result);
                                        };
                                    } else reject(Error(`Store '${storeName}' not found`));

                                    db.close();
                                })
                        });
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
                case 'asc':
                    return 'next'
                case 'desc':
                    return 'prev'
            }
        }
    })
});