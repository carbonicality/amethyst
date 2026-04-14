/*
 *amethyst.js
 *extension runtime
 */

import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

const AMETHYST_DB='amethyst_extensions';
const AMETHYST_DB_VER=1;
const EXT_STORE='extensions';
const EXT_FILES_STORE='extension_files';
const EXT_STORAGE_STORE='extension_storage';

const _extensions={};
const _contentScriptTag=[];
const _msgListeners={};
const _tabMsgListeners={};
const _webReqListeners={};
const _cmdListeners={};
const _ports={};
const _contextMenus={};
const _alarms={};
const _bus=new BroadcastChannel('amethyst_bus');

let _db=null;
let _tabs=null;
let _loadWebsite=null;
let _showNotif=null;
let _getActiveTabId=null;

// indexedDB setup
async function openDB() {
    if (_db) return _db;
    return new Promise((resolve,reject)=>{
        const req=indexedDB.open(AMETHYST_DB,AMETHYST_DB_VER);
        req.onupgradeneeded=(e)=>{
            const db=e.target.result;
            if (!db.objectStoreNames.contains(EXT_STORE)) {
                db.createObjectStore(EXT_STORE,{keyPath:'id'});
            }
            if (!db.objectStoreNames.contains(EXT_FILES_STORE)) {
                db.createObjectStore(EXT_FILES_STORE);
            }
            if (!db.objectStoreNames.contains(EXT_STORAGE_STORE)) {
                db.createObjectStore(EXT_STORAGE_STORE);
            }
        };
        req.onsuccess=()=>{_db=req.result; resolve(_db);};
        req.onerror=()=>reject(req.error);
    });
}

async function dbGet(store,key) {
    const db=await openDB();
    return new Promise((res,rej)=>{
        const tx=db.transaction(store,'readonly');
        const req=tx.objectStore(store).get(key);
        req.onsuccess=()=>res(req.result);
        req.onerror=()=>rej(req.error);
    });
}

async function dbPut(store,key,value) {
    const db=await openDB();
    return new Promise((res,rej)=>{
        const tx=db.transaction(store,'readwrite');
        const req=(key===null)?tx.objectStore(store).put(value):tx.objectStore(store).put(value,key);
    });
}

async function dbDelete(store,key) {
    const db=await openDB();
    return new Promise((res,rej)=>{
        const tx=db.transaction(store,'readwrite');
        const req=tx.objectStore(store).delete(key);
        req.onsuccess=()=>res();
        req.onerror=()=>rej(req.error);
    });
}

async function dbGetAllKeys(store) {
    const db=await openDB();
    return new Promise((res,rej)=>{
        const tx=db.transaction(store,'readonly');
        const req=tx.objectStore(store).getAllKeys();
        req.onsuccess=()=>res(req.result);
        req.onerror=()=>rej(req.error);
    });
}

/*
 * crx zip unpacker
 * CRX2: magic(4)+version(4)+pubkey_len(4)+sig_len(4)+pubkey+sig+zip
 * CRX3: magic(4)+version(4)+header_size(4)+proto_header+zip
 */

function crx2zip(buffer) {
    const view=new DataView(buffer);
    const magic=String.fromCharCode(
        view.getUint8(0),view.getUint8(1),view.getUint8(2),view.getUint8(3)
    );
    if (magic !== 'Cr24') {
        return buffer; // assume raw zip (not crx)
    }
    const version=view.getUint32(4,true);
    let zipStart;
    if (version===2) {
        const pubKeyLen=view.getUint32(8,true);
        const sigLen=view.getUint32(12,true);
        zipStart=16+pubKeyLen+sigLen;
    } else if (version === 3) {
        const headerSize=view.getUint32(8,true);
        zipStart=12+headerSize;
    } else {
        throw new Error(`unknown CRX version: ${version}`);
    }
    return buffer.slice(zipStart);
}

function genExtId(name) {
    let hash=0;
    for (let i=0;i<name.length;i++) {
        hash=((hash<<5)-hash)+name.charCodeAt(i);
        hash|=0;
    }
    const chars='abcdefghijklmnopqrstuvwxyz';
    let id='';
    let n=Math.abs(hash);
    for (let i=0; i<32; i++) {
        id+=chars[n%26];
        n=Math.floor(n/26)+(i*7);
    }
    return id.substring(0,32);
}