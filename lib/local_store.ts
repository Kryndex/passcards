/// <reference path="../typings/DefinitelyTyped/node/node.d.ts" />
/// <reference path="../typings/DefinitelyTyped/q/Q.d.ts" />

// local_store.Store implements an IndexedDB-based store
// of encryption keys and encrypted item data.

// Local Store Schema (v2)
//
// keys: // encryption key and password hint storage
//   hint: string // password hint as plain text
//   key/<ID>: key_agent.Key // encrypted encryption key, plus metadata
//                           // for PBKDF2
//
//
// items: // encrypted item content and sync metadata
//   index: OverviewMap // current overview and revision data for all items
//   lastSynced/<Item ID>: string // last-synced revision of item <Item ID>
//   revision/<rev ID>: ItemRevision // item overview and content (both encrypted) for
//                                   // a particular revision of an item

import assert = require('assert');
import Q = require('q');
import underscore = require('underscore');

import asyncutil = require('./base/asyncutil');
import cached = require('./base/cached');
import collectionutil = require('./base/collectionutil');
import event_stream = require('./base/event_stream');
import item_store = require('./item_store');
import key_agent = require('./key_agent');
import key_value_store = require('./base/key_value_store');
import onepass_crypto = require('./onepass_crypto');

// JSON structure that stores the current overview
// data and revision IDs for all items in the database
interface OverviewMap {
	[index: string] : ItemIndexEntry;
}

// JSON structure used to store item revisions
// in the database
interface ItemRevision {
	parentRevision: string;
	overview: ItemOverview;
	content: item_store.ItemContent;
}

// JSON structure used to store item overview
// data in the database
interface ItemOverview {
	title: string;
	updatedAt: number;
	createdAt: number;
	trashed: boolean;
	typeName: string;
	openContents: item_store.ItemOpenContents;

	locations: string[];
	account: string;

	revision: string;
	parentRevision: string;
}

// JSON structure used to store entries in the item
// index. This consists of item overview data
// plus the last-sync timestamp
interface ItemIndexEntry extends ItemOverview {
	lastSyncedAt?: number;
}

interface LastSyncEntry {
	timestamp: number;
	revision: string;
}

var SCHEMA_VERSION = 2;

// prefix for encryption key entries in the encryption key
// object store
var KEY_ID_PREFIX = 'key/';

export class Store implements item_store.SyncableStore {
	private crypto: onepass_crypto.Crypto;
	private database: key_value_store.Database;
	private keyAgent: key_agent.KeyAgent;
	private keyStore: key_value_store.ObjectStore;
	private itemStore: key_value_store.ObjectStore;
	private indexUpdateQueue: collectionutil.BatchedUpdateQueue<item_store.Item>;
	private itemIndex: cached.Cached<OverviewMap>;

	onItemUpdated: event_stream.EventStream<item_store.Item>;
	onUnlock: event_stream.EventStream<void>;

	constructor(database: key_value_store.Database, keyAgent: key_agent.KeyAgent) {
		this.database = database;
		this.keyAgent = keyAgent;
		this.crypto = onepass_crypto.defaultCrypto;

		this.onItemUpdated = new event_stream.EventStream<item_store.Item>();
		this.onUnlock = new event_stream.EventStream<void>();
		
		this.initDatabase();

		this.indexUpdateQueue = new collectionutil.BatchedUpdateQueue((updates: item_store.Item[]) => {
			return this.updateIndex(updates);
		});

		this.itemIndex = new cached.Cached<OverviewMap>(
			() => { return this.readItemIndex() },
			(update) => { return this.writeItemIndex(update) }
		);
		this.keyAgent.onLock().listen(() => {
			this.itemIndex.clear();
		});
	}

	private initDatabase() {
		this.database.open('passcards-items', SCHEMA_VERSION, (schemaUpdater) => {
			if (schemaUpdater.currentVersion() < 2) {
				schemaUpdater.storeNames().forEach((name) => {
					schemaUpdater.deleteStore(name);
				});
				schemaUpdater.createStore('keys');
				schemaUpdater.createStore('items');
			}
		});

		this.keyStore = this.database.store('keys');
		this.itemStore = this.database.store('items');
	}

	clear() {
		this.itemIndex.clear();
		return this.database.delete().then(() => {
			this.initDatabase();
		});
	}

	unlock(pwd: string) : Q.Promise<void> {
		// FIXME - This duplicates onepass.Vault.unlock()
		return this.listKeys().then((keys) => {
			if (keys.length == 0) {
				throw new Error('No encryption keys have been saved');
			}
			return Q(key_agent.decryptKeys(keys, pwd));
		}).then((keys) => {
			var savedKeys: Q.Promise<void>[] = [];
			keys.forEach((key) => {
				savedKeys.push(this.keyAgent.addKey(key.id, key.key));
			});
			return asyncutil.eraseResult(Q.all(savedKeys)).then(() => {
				this.onUnlock.publish(null);
			});
		});
	}

	listItems(opts: item_store.ListItemsOptions = {}) : Q.Promise<item_store.Item[]> {
		return this.itemIndex.get().then((overviewMap) => {
			var items: item_store.Item[] = [];
			Object.keys(overviewMap).forEach((key) => {
				var overview = overviewMap[key];
				var item = this.itemFromOverview(key, overview);
				if (!item.isTombstone() || opts.includeTombstones) {
					items.push(item);
				}
			});

			return items;
		});
	}

	private getLastSyncEntries(ids: string[]) : Q.Promise<LastSyncEntry[]> {
		return Q.all(ids.map((id) => {
			return this.itemStore.get<LastSyncEntry>('lastSynced/' + id);
		}));
	}

	private updateIndex(updatedItems: item_store.Item[]) {
		var overviewMap = <OverviewMap>{};
		var updatedItemIds = updatedItems.map((item) => {
			return item.uuid;
		});

		return Q.all([this.itemIndex.get(), this.getLastSyncEntries(updatedItemIds)])
		  .then((result) => {
			overviewMap = <OverviewMap>result[0];
			if (!overviewMap) {
				overviewMap = {};
			}
			var lastSyncTimes = (<LastSyncEntry[]>result[1]).map((entry) => {
				return entry ? entry.timestamp : 0;
			});
			updatedItems.forEach((item, index) => {
				var entry: ItemIndexEntry = this.overviewFromItem(item);
				entry.lastSyncedAt = lastSyncTimes[index];
				assert(entry.lastSyncedAt !== null);
				overviewMap[item.uuid] = entry;
			});
			return this.itemIndex.set(overviewMap);
		});
	}

	private itemFromOverview(uuid: string, overview: ItemOverview) {
		var item = new item_store.Item(this, uuid);
		item.title = overview.title;
		item.updatedAt = new Date(overview.updatedAt);
		item.createdAt = new Date(overview.createdAt);
		item.trashed = overview.trashed;
		item.typeName = overview.typeName;
		item.openContents = overview.openContents;
		
		item.account = overview.account;
		item.locations = overview.locations;

		item.revision = overview.revision;
		item.parentRevision = overview.parentRevision;

		return item;
	}

	private overviewFromItem(item: item_store.Item) {
		return <ItemOverview>{
			title: item.title,
			updatedAt: item.updatedAt.getTime(),
			createdAt: item.createdAt.getTime(),
			trashed: item.trashed,
			typeName: <string>item.typeName,
			openContents: item.openContents,

			locations: item.locations,
			account: item.account,

			revision: item.revision,
			parentRevision: item.parentRevision
		};
	}

	loadItem(uuid: string, revision?: string) : Q.Promise<item_store.Item> {
		if (revision) {
			return Q.all([this.overviewKey(), this.itemStore.get<string>('revisions/' + revision)])
			.then((keyAndRevision) => {
				var key = <string>keyAndRevision[0];
				var revisionData = <string>keyAndRevision[1];
				return this.decrypt<ItemRevision>(key, revisionData);
			}).then((revision) => {
				var item = this.itemFromOverview(uuid, revision.overview);
				item.parentRevision = revision.parentRevision;
				return item;
			});
		} else {
			return this.listItems().then((items) => {
				var matches = items.filter((item) => {
					return item.uuid == uuid;
				});
				if (matches.length > 0) {
					return Q(matches[0]);
				} else {
					return Q.reject<item_store.Item>(new Error('No such item ' + uuid));
				}
			});
		}
	}

	saveItem(item: item_store.Item, source: item_store.ChangeSource) : Q.Promise<void> {
		if (source !== item_store.ChangeSource.Sync) {
			// set last-modified time to current time
			item.updateTimestamps();
		} else {
			// when syncing an item from another store, it
			// must already have been saved
			assert(item.createdAt);
			assert(item.updatedAt);
		}

		var key: string;
		return this.keyForItem(item).then((_key) => {
			key = _key;
			return item.getContent();
		}).then((content) => {
			item.updateOverviewFromContent(content);
			item.parentRevision = item.revision;
			item.revision = item_store.generateRevisionId({item: item, content: content});

			var overview = this.overviewFromItem(item);
			var revision = {
				parentRevision: item.parentRevision,
				overview: overview,
				content: content
			};
			return this.encrypt(key, revision);
		}).then((revisionData) => {
			var indexUpdated = this.indexUpdateQueue.push(item);
			var revisionSaved = this.itemStore.set('revisions/' + item.revision, revisionData);
			return asyncutil.eraseResult(Q.all([indexUpdated, revisionSaved]));
		}).then(() => {
			this.onItemUpdated.publish(item);
		});
	}

	getContent(item: item_store.Item) : Q.Promise<item_store.ItemContent> {
		var key: string;
		return this.keyForItem(item).then((_key) => {
			key = _key;
			return this.itemStore.get<string>('revisions/' + item.revision);
		}).then((revisionData) => {
			return this.decrypt<ItemRevision>(key, revisionData);
		}).then((revision) => {
			// TODO - Split item_store.ItemContent into data which can
			// be serialized directly and methods related to that data
			var content = new item_store.ItemContent();
			underscore.extend(content, revision.content);
			return content;
		});
	}

	getRawDecryptedData(item: item_store.Item) : Q.Promise<string> {
		return Q.reject<string>(new Error('getRawDecryptedData() is not implemented'));
	}

	listKeys() : Q.Promise<key_agent.Key[]> {
		return this.keyStore.list(KEY_ID_PREFIX).then((keyIds) => {
			var keys: Q.Promise<key_agent.Key>[] = [];
			keyIds.forEach((id) => {
				keys.push(this.keyStore.get<key_agent.Key>(id));
			});
			return Q.all(keys);
		});
	}

	saveKeys(keys: key_agent.Key[], hint: string) : Q.Promise<void> {
		return this.keyStore.list(KEY_ID_PREFIX).then((keyIds) => {
			// remove existing keys
			var removeOps = keyIds.map((id) => {
				return this.keyStore.remove(id);
			});
			return Q.all(removeOps);
		}).then(() => {
			// save new keys and hint
			var keysSaved: Q.Promise<void>[] = [];
			keys.forEach((key) => {
				keysSaved.push(this.keyStore.set(KEY_ID_PREFIX + key.identifier, key));
			});
			keysSaved.push(this.keyStore.set('hint', hint));
			return asyncutil.eraseResult(Q.all(keysSaved));
		});
	}

	passwordHint() : Q.Promise<string> {
		return this.keyStore.get<string>('hint');
	}

	getLastSyncedRevision(item: item_store.Item) {
		return this.itemStore.get<LastSyncEntry>('lastSynced/' + item.uuid)
		  .then((entry) => {
			  if (entry) {
				  return entry.revision;
			  } else {
				  return null;
			  }
		  });
	}

	setLastSyncedRevision(item: item_store.Item, revision: string) {
		assert(item.revision === revision);
		return this.itemStore.set('lastSynced/' + item.uuid, {
			revision: revision,
			timestamp: item.updatedAt
		}).then(() => {
			return this.indexUpdateQueue.push(item);
		});
	}

	lastSyncTimestamps() {
		var timestamps: Map<string,Date> = new collectionutil.PMap<string,Date>();
		return this.itemIndex.get().then((itemIndex) => {
			Object.keys(itemIndex).forEach((id) => {
				var lastSyncedAt = itemIndex[id].lastSyncedAt;
				timestamps.set(id, new Date(lastSyncedAt));
			});
			return timestamps;
		});
	}

	// encrypt and write the item overview index.
	// Use this.itemIndex.set() instead of this method directly.
	private writeItemIndex(index: OverviewMap) {
		var key: string;
		return this.overviewKey().then((_key) => {
			key = _key;
			return this.encrypt(key, index);
		}).then((encrypted) => {
			return this.itemStore.set('index', encrypted);
		});
	}

	// fetch and decrypt the item overview index.
	// Use this.itemIndex.get() instead of this method directly.
	private readItemIndex() {
		var key: string;
		return this.overviewKey().then((_key) => {
			key = _key;
			return this.itemStore.get<string>('index');
		}).then((encryptedItemIndex) => {
			if (encryptedItemIndex) {
				return this.decrypt<OverviewMap>(key, encryptedItemIndex);
			} else {
				return Q(<OverviewMap>{});
			}
		});
	}

	// returns the key used to encrypt item overview data
	private overviewKey() {
		return this.keyAgent.listKeys().then((keyIds) => {
			if (keyIds.length < 1) {
				throw new Error('Unable to fetch overview key. Vault may be locked?');
			}
			return keyIds[0];
		});
	}

	// returns the key used to encrypt content for a given item
	private keyForItem(item: item_store.Item) {
		return this.overviewKey();
	}

	private encrypt<T>(key: string, data: T) {
		var cryptoParams = new key_agent.CryptoParams(key_agent.CryptoAlgorithm.AES128_OpenSSLKey);
		return this.keyAgent.encrypt(key, JSON.stringify(data), cryptoParams);
	}

	private decrypt<T>(key: string, data: string) : Q.Promise<T> {
		var cryptoParams = new key_agent.CryptoParams(key_agent.CryptoAlgorithm.AES128_OpenSSLKey);
		return this.keyAgent.decrypt(key, data, cryptoParams).then((decrypted) => {
			return <T>JSON.parse(decrypted);
		});
	}
}

