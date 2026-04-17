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

/*
 *install extension from ArrayBuffer
 */
export async function installExtension(buffer,filename='extension.crx') {
    const zipBuffer=crx2zip(buffer);
    const zip=await JSZip.loadAsync(zipBuffer);
    const manifestFile=zip.file('manifest.json');
    if (!manifestFile) throw new Error('no manifest.json found in extension');
    const manifestText=await manifestFile.async('text');
    let manifest;
    try {
        manifest=JSON.parse(manifestText);
    } catch (e) {
        throw new Error('invalid manifest:'+e.message);
    }
    const extId=genExtId(manifest.name+(manifest.version||''));
    console.log(`[amethyst] installing ${manifest.name} v${manifest.version} (${extId})`);
    const files={};
    const fileOps=[];
    zip.forEach((path,file)=>{
        if (!file.dir) {
            fileOps.push(
                file.async('arraybuffer').then(async (ab)=>{
                    const key=`${extId}/${path}`;
                    await dbPut(EXT_FILES_STORE,key,ab);
                    files[path]=true;
                })
            );
        }
    });
    await Promise.all(fileOps);
    const extMeta={
        id:extId,
        manifest,
        enabled:true,
        installedAt:Date.now(),
        filename,
        fileList:Object.keys(files),
    };
    await dbPut(EXT_STORE,null,extMeta);
    await loadExtension(extMeta);
    console.log(`[amethyst] installed: ${manifest.name}`);
    return extId;
}

async function readExtFile(extId,path) {
    const key=`${extId}/${path}`;
    const ab=await dbGet(EXT_FILES_STORE,key);
    return ab||null;
}

async function readExtFileText(extId,path) {
    const ab=await readExtFile(extId,path);
    if (!ab) return null;
    return new TextDecoder().decode(ab);
}

async function readExtFileURL(extId,path) {
    const ab=await readExtFile(extId,path);
    if (!ab) return null;
    const mime=guessMime(path);
    return URL.createObjectURL(new Blob([ab],{type:mime}));
}

function guessMime(path) {
    const ext=path.split('.').pop().toLowerCase();
    const map={
        js:'application/javascript',
        mjs:'application/javascript',
        css:'text/css',
        html:'text/html',
        htm:'text/html',
        json:'application/json',
        png:'image/png',
        jpg:'image/jpeg',
        jpeg:'image/jpeg',
        gif:'image/gif',
        svg:'image/svg+xml',
        webp:'image/webp',
        ico:'image/x-icon',
        woff:'font/woff',
        woff2:'font/woff2',
        ttf:'font/ttf',
    };
    return map[ext]||'application/octet-stream';
}

//manifest helpers
function getMV(manifest) {
    return parseInt(manifest.manifest_version)||2;
}

function getBackgroundInfo(manifest) {
    const mv=getMV(manifest);
    if (mv===3) {
        //mv3, service worker
        const sw=manifest.background?.service_worker;
        return sw?{type:'worker',script:sw}:null;
    } else {
        //mv2, page or scripts
        if (manifest.background?.page) {
            return {type:'page',page:manifest.background.page};
        }
        if (manifest.background?.scripts?.length) {
            return {type:'scripts',scripts:manifest.background.scripts};
        }
        return null;
    }
}

//match a URL against a chrome extension match pattern
//supports <all_urls>, *://*/*, https://*.example.com/path*, etc.

function matchPattern(pattern,url) {
    if (pattern==='<all_urls>') return true;
    if (pattern==='*://*/*') return url.startsWith('https://')||url.startsWith('https://');
    try {
        const escaped=pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\*/g, '.*')
            .replace(/\?/g, '.');
        const schemeMatch=escaped.match(/^([^:]+):\/\//);
        if (!schemeMatch) return false;
        const re=new RegExp('^'+escaped+'$');
        return re.test(url);
    } catch (e) {
        return false;
    }
}

/*
 *build the chrome.* 'shim' script text for injection into the target page
 *this will run in the target context. it will use postMessage to talk back.
 */

function buildChromeShim(extId,tabId,isBackground) {
    return `(function() {
    if (window.__amethyst_shim_loaded) return;
    window.__amethyst_shim_loaded=true;

    const __extId=${JSON.stringify(extId)};
    const __tabId=${JSON.stringify(tabId)};
    const __isBG=${JSON.stringify(isBackground)};
    const __listeners={};
    let __msgIdCounter=0;
    const __pendingCallbacks={};
    const __portListeners={};
    let __portIdCounter=0;

    function __send(type,payload,callback) {
        const msgId=++msgIdCounter;
        const msg={__amethyst:true,type,extId:__extId,tabId:__tabId,msgId,payload};
        if (callback) __pendingCallbacks[msgId]=callback;
        window.parent!==window?window.parent.postMessage(msg,'*'):window.postMessage(msg,'*');
    }
    
    window.addEventListener('message',(e)=>{
        const d=e.data;
        if (!d||!d.__amethyst_reply) return;
        if (d.extId!==__extId) return;
        if (d.msgId&&__pendingCallbacks[d.msgId]) {
            __pendingCallbacks[d.msgId](d.result,d.error);
            delete __pendingCallbacks[d.msgId];
        }
        if (d.event) {
            const handlers=__listeners[d.event]||[];
            handlers.forEach(fn=>{
                try {fn(...(d.args||[]));} catch (ex) {}
            });
        }
    });

    function __mkEvent() {
        const listeners=[];
        return {
            addListener:(fn)=>listeners.push(fn),
            removeListener:(fn)=>{
                const i=listeners.indexOf(fn);
                if (i>-1) listeners.splice(i,1);
            },
            hasListener:(fn)=>listeners.includes(fn),
            _fire:(...args)=>listeners.forEach(fn=>{try{fn(...args);} catch(e) {} })
        };
    }

    //chrome.runtime
    const runtime={
        id: __extId,
        getManifest: ()=>{let m; __send('runtime.getManifest',{},r=>m=r); return m;},
        getURL:(path)=>'amethyst-ext://'+__extId+'/'+path.replace(/^\\//, ''),
        sendMessage:(extIdOrMsg,msgOrOpts,optsOrCb,maybeCb)=>{
            let targetExt,message,callback;
            if (typeof extIdOrMsg==='object') {
                message=extIdOrMsg;callback=msgOrOpts;
                targetExt=__extId;
            } else if (typeof extIdOrMsg==='string' && typeof msgOrOpts==='object') {
                targetExt=extIdOrMsg;message=msgOrOpts;callback=typeof optsOrCb==='function'?optsOrCb:maybeCb;
            } else {
                message=extIdOrMsg;callback=msgOrOpts;
                targetExt=__extId;
            }
            __send('runtime.sendMessage',{targetExt,message},callback||(()=>{}));
        },
        onMessage:__mkEvent(),
        onInstalled:__mkEvent(),
        onStartup:__mkEvent(),
        onConnect:__mkEvent(),
        connect: (connectInfo) =>{
            const portId='port_'+(++_portIdCounter);
            __send('runtime.connect',{portId,name:connectInfo?.name,extId:__extId});
            return __mkPort(portId,connectInfo?.name);
        },
        lastError:null,
        getPlatformInfo:(cb)=>cb&&cb({os:'linux',arch:'x86-64',nacl_arch:'x86_64'}),
        openOptionsPage:()=>__send('runtime.openOptionsPage',{}),
        setUninstallURL:()=>{},
        requestUpdateCheck:(cb)=>cb&&cb('no_update',{}),
    };
    __listeners['runtime.onMessage']=runtime.onMessage._fire;

    function __mkPort(portId,name) {
        const port={
            name:name||'',
            postMessage:(msg)=>__send('port.postMessage',{portId,msg}),
            disconnect:()=>__send('port.disconnect',{portId}),
            onMessage:__mkEvent(),
            onDisconnect:__mkEvent(),
        };
        __portListeners[portId]=port;
        return port;
    }
    
    //chrome.storage
    function __mkStorageArea(area) {
        return {
            get:(keys,cb)=>__send('storage.get',{area,keys},cb),
            set:(items,cb)=>__send('storage.set',{area,items},(r)=>cb&&cb()),
            remove:(keys,cb)=>__send('storage.remove',{area,keys},(r)=>cb&&cb()),
            clear:(cb)=>__send('storage.clear',{area},(r)=>cb&&cb()),
            getBytesInUse: (keys,cb)=>cb&&cb(0),
        };
    }
    const storage={
        local:__mkStorageArea('local'),
        sync:__mkStorageArea('sync'),
        session:__mkStorageArea('session'),
        managed:__mkStorageArea('managed'),
        onChanged:__mkEvent(),
    };

    //chrome.tabs
    const tabs={
        query:(queryInfo,cb)=>__send('tabs.query',queryInfo,cb),
        get:(tabId,cb)=>__send('tabs.get',{tabId},cb),
        create:(createProps,cb)=>__send('tabs.create',createProps,cb),
        update:(tabId,updateProps,cb)=>__send('tabs.update',{tabId,updateProps}.cb),
        remove:(tabIds,cb)=>__send('tabs.remove',{tabIds},(r)=>cb&&cb()),
        sendMessage:(tabId,message,opts,cb)=>{
            const callback=typeof opts==='function'?opts:cb;
            __send('tabs.sendMessage',{tabId,message},callback);
        },
        getCurrent:(cb)=>__send('tabs.getCurrent',{},cb),
        onCreated:__mkEvent(),
        onUpdated:__mkEvent(),
        onRemoved:__mkEvent(),
        onActivated:__mkEvent(),
        executeScript:(tabIdOrDetails,details,cb)=>{
            const actualTabId=typeof tabIdOrDetails==='number'?tabIdOrDetails:__tabId;
            const actualDetails=typeof tabIdOrDetails==='object'?tabIdOrDetails:details;
            const callback=typeof details==='function'?details:cb;
            __send('tabs.executeScript',{tabId:actualTabId,details:actualDetails},callback);
        },
        insertCSS:(tabIdOrDetails,details,cb)=>{
            const actualTabId=typeof tabIdOrDetails==='number'?tabIdOrDetails:__tabId;
            const actualDetails=typeof tabIdOrDetails==='object'?tabIdOrDetails:details;
            __send('tabs.insertCSS',{tabId:actualTabId,details:actualDetails},cb);
        },
        captureVisibleTab:(windowId,opts,cb)=>{
            const callback=typeof windowId==='function'?windowId:typeof opts==='function'?opts:cb;
            __send('tabs.captureVisibleTab',{},callback);
        },
        TAB_ID_NONE:-1,
    };

    //chrome.windows
    const windows={
        getCurrent:(cb)=>cb&&cb({id:1,focused:true,type:'normal',state:'normal'}),
        getAll:(cb)=>cb&&cb([{id:1,focused:true,type:'normal',state:'normal'}]),
        create:(createData,cb)=>__send('windows.create',createData,cb),
        onFocusChanged:__mkEvent(),
        WINDOW_ID_NONE:-1,
        WINDOW_ID_CURRENT:-2,
    };

    //chrome.extension
    const extension={
        getURL:runtime.getURL,
        getBackgroundPage:()=>null,
        isAllowedIncognitoAccess:(cb)=>cb&&cb(false),
        isAllowedFileSchemeAccess:(cb)=>cb&&cb(false),
        onMessage:runtime.onMessage,
        onMessageExternal:__mkEvent(),
        sendMessage:runtime.sendMessage,
    };

    //chrome.i18n
    const i18n={
        getMessage:(messageName,substitutions)=>{
            let result;
            __send('i18n.getMessage',{messageName,substitutions},r=>result=r);
            return result||messageName;
        },
        getUILanguage:()=>navigator.language||'en',
        detectLanguage:(text,cb)=>cb&&cb({isReliable:false,languages:[]}),
        getAcceptLanguage:(cb)=>cb&&cb([navigator.language||'en']),
    };

    //chrome.contextMenus
    const contextMenus={
        create:(props,cb)=>{__send('contextMenus.create',props,cb);return props.id||Math.random().toString(36).slice(2)},
        update:(id,props,cb)=>__send('contextMenus.update',{id,props},cb),
        remove:(id,cb)=>__send('contextMenus.remove',{id},cb),
        removeAll:(cb)=>__send('contextMenus.removeAll',{},cb),
        onClicked:__mkEvent(),
    };

    //chrome.notifications
    const notifications={
        create:(notifId,options,cb)=>{
            const id=notifId||('notif_'+Date.now());
            __send('notifications.create',{notifId:id,options},cb);
            return id;
        },
        update:(notifId,options,cb)=>__send('notifications.update',{notifId,options},cb),
        clear:(notifId,cb)=>__send('notifications.clear',{notifId},cb),
        getAll:(cb)=>__send('notifications.getAll',{},cb),
        onClicked:__mkEvent(),
        onClosed:__mkEvent(),
        onButtonClicked:__mkEvent(),
    };

    //chrome.cookies
    const cookies={
        get:(details,cb)=>__send('cookies.get',details,cb),
        getAll:(details,cb)=>__send('cookies.getAll',details,cb),
        set:(details,cb)=>__send('cookies.set',details,cb),
        remove:(details,cb)=>__send('cookies.remove',details,cb),
        onChanged:__mkEvent(),
    };

    //chrome.webRequest
    function __mkWebReqEvent(eventName) {
        return {
            addListener: (fn,filter,extraInfoSpec) => {
                __send('webRequest.addListener',{eventName,filter,extraInfoSpec});
                __listeners[eventName]=__listeners[eventName]||[];
                __listeners[eventName].push(fn);
            },
            removeListener: (fn)=>{
                const arr=__listeners[eventName]||[];
                const i=arr.indexOf(fn);
                if (i>-1) arr.splice(i,1);
            },
            hasListener:(fn)=>(__listeners[eventName]||[]).includes(fn),
        };
    }
    const webRequest={
        onBeforeRequest:__mkWebReqEvent('webRequest.onBeforeRequest'),
        onBeforeSendHeaders:__mkWebReqEvent('webRequest.onBeforeSendHeaders'),
        onSendHeaders:__mkWebReqEvent('webRequest.onSendHeaders'),
        onHeadersReceived:__mkWebReqEvent('webRequest.onHeadersReceived'),
        onCompleted:__mkWebReqEvent('webRequest.onCompleted'),
        onErrorOccurred:__mkWebReqEvent('webRequest.onErrorOccurred'),
        onBeforeRedirect:__mkWebReqEvent('webRequest.onBeforeRedirect'),
        handlerBehaviorChanged:(cb)=>cb&&cb(),
    };

    //chrome.declarativeNetRequest
    const declarativeNetRequest={
        updateDynamicRules:(options,cb)=>__send('dnr.updateDynamicRules',options,cb),
        getDynamicRules:(cb)=>__send('dnr.getDynamicRules',{},cb),
        updateSessionRules:(options,cb)=>__send('dnr.updateSessionRules',options,cb),
        getSessionRules:(cb)=>__send('dnr.getSessionRules',{},cb),
        isRegexSupported:(regexOptions,cb)=>cb&&({isSupported:true}),
        testMatchOutcome:(request,cb)=>__send('dnr.testMatchOutcome',request,cb),
        MAX_NUMBER_OF_RULES:30000,
        MAX_NUMBER_OF_DYNAMIC_RULES:5000,
        GUARANTEED_MINIMUM_STATIC_RULES:30000,
    };
    
    //chrome.scripting (MV3)
    const scripting={
        executeScript:(injection,cb)=>__send('scripting.executeScript',injection,cb),
        insertCSS:(injection,cb)=>__send('scripting.insertCSS',injection,cb),
        removeCSS:(injection.cb)=>__send('scripting.removeCSS',injection,cb),
        registerContentScripts:(scripts,cb)=>__send('scripting.registerContentScripts',{scripts},cb),
        unregisterContentScripts:(filter,cb)=>__send('scripting.unregisterContentScripts',filter,cb),
        getRegisteredContentScripts:(filter,cb)=>__send('scripting.getRegisteredContentScripts',filter,cb),
    };

    //chrome.action
    function __mkAction() {
        return {
            setIcon:(details,cb)=>__send('action.setIcon',details,cb),
            setTitle:(details,cb)=>__send('action.setTitle',details,cb),
            setBadgeText:(details,cb)=>__send('action.setBadgeText',details,cb),
            setBadgeBackgroundColor:(details,cb)=>__send('action.setBadgeBackground',details,cb),
            getBadgeText:(details,cb)=>__send('action.getBadgeText',details,cb),
            enable:(tabId,cb)=>__send('action.enable',{tabId},cb),
            disable:(tabId,cb)=>__send('action.disable',{tabId},cb),
            onClicked:__mkEvent(),
            openPopup:(options,cb)=>__send('action.openPopup',options||{},cb),
            setPopup:(details,cb)=>__send('action.setPopup',details,cb),
            getPopup:(details,cb)=>__send('action.getPopup',details,cb),
        };
    }
    const action=__mkAction();
    const browserAction=__mkAction();
    const pageAction=__mkAction();

    //chrome.alarms
    const alarms={
        create:(name,alarmInfo)=>__send('alarms.create',{name,alarmInfo}),
        get:(name,cb)=>__send('alarms.get',{name},cb),
        getAll:(cb)=>__send('alarms.getAll',{},cb),
        clear:(name,cb)=>__send('alarms.clear',{name},(r)=>cb&&cb(r)),
        clearAll:(cb)=>__send('alarms.clearAll',{},(r)=>cb&&cb(r)),
        onAlarms:__mkAlert(),
    };

    //chrome.permissions
    const permissions={
        request:(perms,cb)=>cb&&cb(true),
        contains:(perms,cb)=>cb&&cb(true),
        getAll:(cb)=>cb&&cb({permissions:[],origins:[]}),
        remove:(perms,cb)=>cb&&cb(true),
        onAdded:__mkEvent(),
        onRemoved:__mkEvent(),
    };

    //chrome.history
    const history={
        search:(query,cb)=>__send('history.search',query,cb),
        getVisits:(details,cb)=>__send('history.getVisits',details,cb),
        addUrl:(details,cb)=>__send('history.addUrl',details,cb),
        deleteUrl:(details,cb)=>__send('history.deleteUrl',details,cb),
        deleteAll:(cb)=>__send('history.deleteAll',{},cb),
        onVisited:__mkEvent(),
        onVisitRemoved:__mkEvent(),
    };

    //chrome.bookmarks
    const bookmarks={
        get:(idOrList,cb)=>__send('bookmarks.get',{ids:idOrList},cb),
        getTree:(cb)=>__send('bookmarks.getTree',{},cb),
        search:(query,cb)=>__send('bookmarks.search',{query},cb),
        create:(bookmark,cb)=>__send('bookmarks.create',bookmark,cb),
        remove:(id,cb)=>__send('bookmarks.remove',{id},cb),
        onCreated:__mkEvent(),
        onRemoved:__mkEvent(),
        onChanged:__mkEvent(),
    };

    //chrome.downloads
    const downloads={
        download:(options,cb)=>__send('downloads.download',options,cb),
        search:(query,cb)=>__send('downloads.search',query,cb),
        pause:(id,cb)=>cb&&cb(),
        resume:(id,cb)=>cb&&cb(),
        cancel:(id,cb)=>cb&&cb(),
        onCreated:__mkEvent(),
        onChanged:__mkEvent(),
    };

    //chrome.identity
    const identity={
        getAuthToken:(details,cb)=>cb&&cb(undefined),
        launchWebAuthFlow:(details,cb)=>__send('identity.launchWebAuthFlow',details,cb),
        getRedirectURL:(path)=>'https://amethyst.invalid/'+__extId+'/'+(path||''),
        removeCachedAuthToken:(details,cb)=>cb&&cb(),
    };

    //chrome.commands
    const commands={
        getAll:(cb)=>__send('commands.getAll',{},cb),
        onCommand:__mkEvent(),
    };
    __listeners['commands.onCommand']=commands.onCommand._fire;

    //chrome.omnibox
    const omnibox={
        setDefaultSuggestion:(suggestion)=>__send('omnibox.setDefaultSuggestion',suggestion),
        onInputStarted:__mkEvent(),
        onInputChanged:__mkEvent(),
        onInputEntered:__mkEvent(),
        onInputCancelled:__mkEvent(),
    };

    //chrome.contentSettings
    const contentSettings={};

    //chrome.proxy
    const proxy={
        settings:{
            get:(details,cb)=>cb&&cb({value:{mode:'direct'},levelOfControl:'controlled_by_this_extension'}),
            set:(details,cb)=>cb&&cb(),
            clear:(details,cb)=>cb&&cb(),
        },
        onProxyError:__mkEvent(),
    };

    //chrome.system
    const system={
        cpu:{getInfo:(cb)=>cb&&cb({numOfProcessors:4,arch-name:'x86-64',modelName:'Amethyst vCPU',features:[]})},
        memory:{getInfo:(cb)=>cb&&cb({capacity:8*1024*1024*1024,availableCapacity:4*1024*1024*1024})},
        storage:{getInfo:(cb)=>cb&&cb([])},
        display:{getInfo:(cb)=>cb&&cb([{id:'0',isPrimary:true,isInternal:false,isEnabled:true,bounds:{left:0,top:0,width:screen.width,height:screen.height}}])},
    };

    //chrome.power
    const power={
        requestKeepAwake:(level)=>{},
        releaseKeepAwake:()=>{},
    };

    //chrome.management
    const management={
        getSelf:(cb)=>__send('management.getSelf',{},cb),
        getAll:(cb)=>__send('management.getAll',{},cb),
        setEnabled:(id,enabled,cb)=>__send('management.setEnabled',{id,enabled},cb),
        uninstallSelf:(options,cb)=>__send('management.uninstallSelf',options||{},cb),
        onEnabled:__mkEvent(),
        onDisabled:__mkEvent(),
    };

    //chrome.webNavigation
    const webNavigation={
        getFrame:(details,cb)=>cb&&cb(null),
        getAllFrames:(details,cb)=>cb&&cb([]),
        onBeforeNavigate:__mkEvent(),
        onCommitted:__mkEvent(),
        onCompleted:__mkEvent(),
        onDOMContentLoaded:__mkEvent(),
        onErrorOccurred:__mkEvent(),
        onHistoryStateUpdated:__mkEvent(),
        onReferenceFragmentUpdated:__mkEvent(),
    };

    //chrome.tts
    const tts={
        speak:(utterance,options,cb)=>{
            const u=new SpeechSynthesisUtterance(utterance);
            if (options?.lang) u.lang=options.lang;
            if (options?.rate) u.rate=options.rate;
            if (options?.pitch) u.pitch=options.pitch;
            if (options?.volume) u.volume=options.volume;
            speechSynthesis.speak(u);
            cb&&cb();
        },
        stop:()=>speechSynthesis.cancel(),
        isSpeaking:(cb)=>cb&&cb(speechSynthesis.speaking),
        getVoices:(cb)=>cb&&cb(speechSynthesis.getVoices().map(v=>({voiceName:v.name,lang:v.lang,remote:false,extensionId:''}))),
        onEvent:__mkEvent(),
    };

    //chrome.clipboard
    const clipboard={
        setImageData:(imageData,type,cb)=>cb&&cb(),
    };

    //chrome.fontSettings
    const fontSettings={
        getFont:(details,cb)=>cb&&cb({fontId:'Arial',levelOfControl:'controllable_by_this_extension'}),
        setFont:(details,cb)=>cb&&cb(),
        clearFont:(details,cb)=>cb&&cb(),
        onFontChanged:__mkEvent(),
    };

    //build chrome obj
    window.chrome={
        runtime,storage,tabs,windows,extension,i18n,contextMenus,notifications,cookies,webRequest,declarativeNetRequest,scripting,action,browserAction,pageAction,alarms,permissions,history,bookmarks,downloads,identity,commands,omnibox,contentSettings,proxy,system,power,management,webNavigation,tts,clipboard,fontSettings,
        app: {
            getDetails:()=>null,
            isInstalled:false,
            InstallState:{DISABLED:'disabled',INSTALLED:'installed',NOT_INSTALLED:'not_installed'},
            RunningState:{CANNOT_RUN:'cannot_run',READY_TO_RUN:'ready_to_run',RUNNING:'running'},
        },
        csi:()=>{},
        loadTimes:()=>({}),
    };

    if (!window.browser) {
        window.browser=window.chrome;
    }

    if (typeof self !== 'undefined' && self !== window) {
        self.chrome=window.chrome;
        self.browser=window.chrome;
    }
    })();`;
}

/*
 *shim message handler
 *handle a message posted from the chrome shim
 *translates the shim's requests into amethyst operations
 */
async function handleShimMessage(event) {
    const d=event.data;
    if (!d||!d.__amethyst) return;
    const {type,extId,tabId,msgId,payload}=d;
    const source=event.source;

    function reply(result,error){
        if (!source) return;
        try {
            source.postMessage({__amethyst_reply:true,extId,tabId,msgId,result,error},'*');
        } catch (e) {}
    }

    function fireEvent(targetExtid,eventName,args) {
        const ext=_extensions[targetExtId];
        if (ext?.bgFrame) {
            try {
                ext.bgFrame.contentWindow?.postMessage({
                    __amethyst_reply:true,extId:targetExtId,tabId:null,msgId:null,
                    event:eventName,args
                },'*');
            } catch (e) {}
        }
    }

    switch(type) {
        //storage
        case 'storage.get': {
            const {area,keys}=payload;
            const result={};
            const allKeys=await dbGetAllKeys(EXT_STORAGE_STORE);
            const prefix=`${extId}/${area}`;
            const relevantKeys=allKeys.filter(k=>k.startsWith(prefix));
            for (const k of relevantKeys) {
                const shortKey=k.slice(prefix.length);
                let include=false;
                if (keys===null||keys===undefined) include=true;
                else if (typeof keys==='string') include=shortKey===keys;
                else if (Array.isArray(keys)) include=keys.includes(shortKey);
                else if (typeof keys==='object') include=shortKey in keys;
                if (include) result[shortKey]=await dbGet(EXT_STORAGE_STORE,k);
            }
            if (typeof keys==='object'&&!Array.isArray(keys)&&keys!==null) {
                Object.entries(keys).forEach(([k,v])=>{
                    if (!(k in result)) result[k]=v;
                });
            }
            reply(result);
            break;
        }
        case 'storage.get': {
            const {area,items} = payload;
            for (const [key,value] of Object.entries(items)) {
                await dbPut(EXT_STORAGE_STORE,`${extId}/${area}/${key}`,value);
            }
            reply({});
            break;
        }
        case 'storage.remove': {
            const {area,keys}=payload;
            const arr=Array.isArray(keys)?keys:[keys];
            for (const key of arr) {
                await dbDelete(EXT_STORAGE_STORE,`${extId}/${area}/${key}`);
            }
            reply({});
            break;
        }
        case 'storage.clear': {
            const {area}=payload;
            const allKeys=await dbGetAllKeys(EXT_STORAGE_STORE);
            const prefix=`${extId}/${area}/`;
            for (const k of allKeys.filter(k=>k.startsWith(prefix))) {
                await dbDelete(EXT_STORAGE_STORE,k);
            }
            reply({});
            break;
        }
        
        //runtime
        case 'runtime.getManifest': {
            reply(_extensions[extId]?.manifest||{});
            break;
        }
        case 'runtime.sendMessage': {
            const {targetExt,message}=payload;
            const target=_extensions[targetExt||extId];
            if (!target?.bgFrame) {reply(null);break;}
            const bgWin=target.bgFrame.contentWindow;
            if (!bgWin) {reply(null);break;}
            try {
                bgWin.postMessage({
                    __amethyst_reply:true,extId:targetExt||extId,
                    tabId,msgId:null,event:'runtime.onMessage',
                    args:[message,{tab:_buildTabObj(tabId),id:extId},(resp)=>reply(resp)]
                },'*');
            } catch (e) {reply(null);}
            break;
        }
        case 'runtime.openOptionsPage': {
            const ext=_extensions[extId];
            const optionsPage=ext?.manifest?.options_page||ext?.manifest.options_ui?.page;
            if (optionsPage) {
                const url=await readExtFileURL(extId,optionsPage);
                if (url&&_loadWebsite) _loadWebsite(url);
            }
            reply({});
            break;
        }
        
        //tabs
        case 'tabs.query': {
            const result=Object.entries(_tabs||{}).map(([id,t])=>_buildTabObj(id)).filter(Boolean);
            const q=payload;
            const filtered=result.filter(tab=>{
                if (q.active!==undefined&&q.active!==(tab.id==_getActiveTabId?.())) return false;
                if (q.url&&!tab.url?.includes(q.url)) return false;
                return true;
            });
            reply(filtered);
            break;
        }
        case 'tabs.get': {
            reply(_buildTabObj(payload.tabId));
            break;
        }
        case 'tabs.getCurrent': {
            reply(_buildTabObj(tabId));
            break;
        }
        case 'tabs.create': {
            if (_loadWebsite) _loadWebsite(payload.url||'');
            reply(_buildTabObj(tabId));
            break;
        }
        case 'tabs.update': {
            if (payload.updateProps?.url&&_loadWebsite) _loadWebsite(payload.updateProps.url);
            reply(_buildTabObj(payload.tabId||tabId));
            break;
        }
        case 'tabs.sendMessage': {
            const targetTabId=payload.tabId;
            const tabListeners=_tabMsgListeners[targetTabId]||[];
            tabListeners.forEach(fn=>{
                try {
                    fn(payload.message,{tab:_buildTabObj(tabId),id:extId},reply);
                } catch(e) {}
            });
            if (!tabListeners.length) reply(null);
            break;
        }
        case 'tabs.executeScript': {
            const iframe=_getIframe(payload.tabId||tabId);
            if (!iframe) {reply(null);break;}
            const details=payload.details||{};
            if (details.code) {
                try {
                    const result=iframe.contentWindow?.eval(details.code);
                    reply([result]);
                } catch (e) {reply(null);}
            } else if (details.file) {
                const code=await readExtFileText(extId,details.file);
                if (code) {
                    injectScript(iframe,code,extId);
                    reply([null]);
                } else {reply(null);}
            }
            break;
        }
        case 'tabs.insertCSS': {
            const iframe=_getIframe(payload.tabId||tabId);
            if (!iframe) {
                reply(null);
                break;
            }
            const details=payload.details||{};
            if (details.code) {
                injectCSS(iframe,details.code);
            } else if (details.file) {
                const css=await readExtFileText(extId,details.file);
                if (css) injectCSS(iframe,css);
            }
            reply(null);
            break;
        }
        case 'tabs.captureVisibleTab': {
            const iframe=_getIframe(tabId);
            reply(null);
            break;
        }

        //scripting (mv3)
        case 'scripting.executeScript': {
            const {target,func,args:scriptArgs,files}=payload;
            const tId=target?.tabId||tabId;
            const iframe=_getIframe(tId);
            if (!iframe) {reply(null);break;}
            if (func) {
                try {
                    const fn=new Function('return ('+func.toString()+')')()(... (scriptArgs||[]));
                    reply([{result:fn}]);
                } catch (e) {reply(null);}
            } else if (files?.length) {
                for (const file of files) {
                    const code=await readExtFileText(extId,file);
                    if (code) injectScript(iframe,code,extId);
                }
                reply([{result:null}]);
            } else {reply(null);}
            break;
        }
        case 'scripting.insertCSS': {
            const {target,css,files}=payload;
            const tId=target?.tabId||tabId;
            const iframe=_getIframe(tId);
            if (!iframe) {reply(null);break;}
            if (css) injectCSS(iframe,css);
            if (files?.length) {
                for (const file of files) {
                    const code=await readExtFileText(extId,file);
                    if (code) injectCSS(iframe,code);
                }
            }
            reply(null);
            break;
        }
        
        //action/browserAction
        case 'action.setBadgeText': {
            const {text}=payload;
            const ext=_extensions[extId];
            if (ext) ext._badgeText=text||'';
            _updateExtButton(extId);
            reply(null);
            break;
        }
        case 'action.setBadgeBackground': {
            const ext=_extensions[extId];
            if (ext) ext._badgeColor=payload.color;
            _updateExtButton(extId);
            reply(null);
            break;
        }
        case 'action.setIcon': {
            const ext=_extensions[extId];
            if (payload.imageData) {
                if (ext) ext._iconDataUrl=typeof payload.imageData==='object'?Object.values(payload.imageData)[0]:payload.imageData;
            } else if (payload.path) {
                const p =typeof payload.path==='object'?Object.values(payload.path)[0]:payload.path;
                const url=await readExtFileURL(extId,p);
                if (url&&ext) ext._iconUrl=url;
            }
            _updateExtButton(extId);
            reply(null);
            break;
        }
        case 'action.setTitle': {
            const ext=_extensions[extId];
            if (ext) ext._title=payload.title;
            _updateExtButton(extId);
            reply(null);
            break;
        }
        case 'action.setPopup': {
            const ext=_extensions[extId];
            if (ext) ext._popupPage=payload.popup;
            reply(null);
            break;
        }
        case 'action.openPopup': {
            openExtensionPopup(extId);
            reply(null);
            break;
        }

        //notifications
        case 'notifications.create': {
            const {options}=payload;
            if (_showNotif) _showNotif(options.title||'Extension',options.message||'');
            reply(payload.notifId);
            break;
        }
        case 'notifications.clear': {
            reply(true);
            break;
        }

        //cookies 
        case 'cookies.get': {
            const frame=_getIframe(tabId);
            let val=null;
            if (iframe) {
                try {
                    const all=iframe.contentDocument?.cookie?.split(';')||[];
                    const found=all.find(c=>c.trim().startsWith(payload.name+'='));
                    if (found) {
                        const value=found.split('=').slice(1).join('=').trim();
                        val={name:payload.name,value,domain:payload.domain||'',path:'/'};
                    }
                } catch (e) {}
            }
            reply(val);
            break;
        }
        case 'cookies.set': {
            const iframe=_getIframe(tabId);
            if (iframe) {
                try {
                    let c=`${payload.name}=${payload.value}`;
                    if (payload.path) c+=`;path=${payload.path}`;
                    if (payload.domain) c+=`;domain=${payload.domain}`;
                    iframe.contentDocument.cookie=c;
                } catch (e) {}
            }
            reply(null);
            break;
        }
        case 'cookies.getAll': {
            reply([]);
            break;
        }

        //i18n
        case 'i18n.getMessage': {
            const {messageName,substitutions}=payload;
            const ext=_extensions[extId];
            const msg=ext?._messages?.[messageName];
            if (!msg) {reply('');break;}
            let text=msg.message||'';
            if (substitutions){
                const subs=Array.isArray(substitutions)?substitutions:[substitutions];
                subs.forEach((s,i)=>{text=text.replace(new RegExp('\\$'+(i+1),'g'),s);});
            }
            reply(text);
            break;
        }
        
        //contextMenus
        case 'contextMenus.create': {
            if (!_contextMenus[extId]) _contextMenus[extId]=[];
            _contextMenus[extId].push(payload);
            reply(payload.id);
            break;
        }
        case 'contextMenus.removeAll': {
            _contextMenus[extId]=[];
            reply(null);
            break;
        }

        //alarms
        case 'alarms.create': {
            if (!_alarms[extId]) _alarms[extId]={};
            const {name,alarmInfo}=payload;
            const alarmName=name||'';
            const existing=_alarms[extId][alarmName];
            if (existing?.timer) clearInterval(existing.timer);
            const delayMs=(alarmInfo?.delayInMinutes||0)*60000;
            const periodMs=(alarmInfo?.periodInMinutes)?alarmInfo.periodInMinutes*60000:null;
            const scheduledTime=Date.now()+delayMs;
            const fire=()=>{fireEvent(extId,'alarms.onAlarm',[{name:alarmName,scheduledTime,periodInMinutes:alarmInfo?.periodInMinutes}]);};
            let timer;
            if (periodMs) {
                timer=setTimeout(()=>{fire();setInterval(fire,periodMs);},delayMs);
            } else {
                timer=setTimeout(fire,delayMs);
            }
            _alarms[extId][alarmName]={alarmInfo,scheduledTime,timer};
            reply(null);
            break;
        }
        case 'alarms.get': {
            const alarm=_alarms[extId]?.[payload.name||''];
            reply(alarm?{name:payload.name||'',scheduledTime:alarm.scheduledTime,periodInMinutes:alarm.alarmInfo?.periodInMinutes}:null);
            break;
        }
        case 'alarms.getAll': {
            const all = Object.entries(_alarms[extId]||{}).map(([name,a])=>({
                name,scheduledTime:a.scheduledTime,periodInMinutes:a.alarmInfo?.periodInMinutes
            }));
            reply(all);
            break;
        }
        case 'alarms.clear': {
            const alarm=_alarms[extId]?.[payload.name||''];
            if (alarm?.timer) clearInterval(alarm.timer);
            if (_alarms[extId]) delete _alarms[extId][payload.name||''];
            reply(true);
            break;
        }

        //history
        case 'history.search': {
            const kryptonHistory=JSON.parse(localStorage.getItem('krypton_history')||'[]');
            const q=(payload.text||'').toLowerCase();
            const results=kryptonHistory
                .filter(h=>h.url?.toLowerCase().includes(q)||h.title?.toLowerCase().includes(q))
                .slice(0,payload.maxResults||100)
                .map(h=>({id:h.timestamp?.toString(),url:h.url,title:h.title,lastVisitTime:h.timestamp,visitCount:1}));
                reply(results);
                break;
        }
        case 'history.addUrl': {
            reply(null);
            break;
        }

        //bookmarks
        case 'bookmarks.getTree': {
            const bms=JSON.parse(localStorage.getItem('krypton_bookmarks')||'[]');
            const tree=[{
                id: '0', title:'Bookmarks bar',children:bms.map((b,i)=>({
                    id:String(i), title:b.title||b.url,url:b.url,parentId:'0'
                }))
            }];
            reply(tree);
            break;
        }
        case 'bookmarks.search': {
            const bms=JSON.parse(localStorage.getItem('krypton_bookmarks')||'[]');
            const q=typeof payload.query==='string'?payload.query.toLowerCase():'';
            reply(bms.filter(b=>b.url?.toLowerCase().includes(q)||b.title?.toLowerCase().includes(q))
                    .map((b,i)=>({id:String(i),title:b.title||'',url:b.url,parentId:'0'})));
            break;
        }
        case 'bookmarks.create': {
            const bms=JSON.parse(localStorage.getItem('krypton_bookmarks')||'[]');
            bms.push({url:payload.url,title:payload.title||payload.url});
            localStorage.setItem('krypton_bookmarks',JSON.stringify(bms));
            reply({id:String(bms.length-1),...payload});
            break;
        }

        //downloads
        case 'downloads.download': {
            const a=document.createElement('a');
            a.href=payload.url;
            if (payload.filename) a.download=payload.filename;
            else a.download='';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            reply(1);
            break;
        }

        //webRequest listeners
        case 'webRequest.addListener': {
            const {eventName,filter}=payload;
            if(!_webReqListeners[eventName]) _webReqListeners[eventName]=[];
            _webReqListeners[eventName].push({extId,filter});
            reply(null);
            break;
        }

        //declarativeNetRequest
        case 'dnr.updateDynamicRules': {
            const {addRules,removeRuleIds}=payload;
            if (!extensions[extId]) break;
            const ext=_extensions[extId];
            if(!ext._dnrRules) ext._dnrRules=[];
            if (removeRuleIds) ext._dnrRules=ext._dnrRules.filter(r=>!removeRuleIds.includes(r.id));
            if (addRules) ext._dnrRules.push(...addRules);
            reply(null);
            break;
        }
        case 'dnr.getDynamicRules': {
            reply(_extensions[extId]?._dnrRules||[]);
            break;
        }

        //management
        case 'management.getSelf': {
            const ext=_extensions[extId];
            reply({id:extId,name:ext?.manifest?.name||'',version:ext?.manifest?.version||'',enabled:true,type:'extension'});
            break;
        }
        case 'management.getAll': {
            const all=Object.entries(_extensions).map(([id,ext])=>({
                id,name:ext.manifest?.name||'',version:ext.manifest?.version||'',enabled:ext.enabled,type:'extension'
            }));
            reply(all);
            break;
        }

        //commands
        case 'commands.getAll': {
            const cmds=_extensions[extId]?.manifest?.commands||{};
            reply(Object.entries(cmds).map(([name,cmd])=>({
                name,description:cmd.description||'',shortcut:cmd.suggested_key?.default||''
            })));
            break;
        }

        default:
            reply(null);
    }
}

//helper utilities
function _buildTabObj(tabId) {
    if (!_tabs||!tabId) return null;
    const t=_tabs[tabId];
    if (!t) return null;
    return {
        id:parseInt(tabId),
        index:parseInt(tabId)-1,
        windowId:1,
        highlighted:true,
        active:tabId==_getActiveTabId?.(),
        pinned:false,
        audible:false,
        discarded:false,
        autoDiscardable:false,
        mutedInfo:{muted:false},
        url:t.url||'',
        title:t.title||'',
        favIconUrl:'',
        status:'complete',
        incognito:false,
        width:800,
        height:600,
    };
}

function _getIframe(tabId) {
    if (!_tabs||!tabId) return null;
    const t=_tabs[tabId];
    return t?.iframe||null;
}

function injectScript(iframe,code,extId) {
    try {
        const doc=iframe.contentDocument;
        if (!doc) return;
        const script=doc.createElement('script');
        script.textContent=code;
        (doc.head||doc.documentElement).appendChild(script);
    } catch (e) {
        console.warn('[amethyst] injectScript failed: ',e);
    }
}

function injectCSS(iframe,css) {
    try {
        const doc=iframe.contentDocument;
        if (!doc) return;
        const style=doc.createElement('style');
        style.textContent=css;
        (doc.head||doc.documentElement).appendChild(style);
    } catch (e) {
        console.warn('[amethyst] injectCSS failed: ',e);
    }
}

//background script runner
async function startBackground(extId) {
    const ext=_extensions[extId];
    if (!ext) return;
    const bgInfo=getBackgroundInfo(ext.manifest);
    if (!bgInfo) return;
    if (ext.bgFrame) {
        ext.bgFrame.remove();
        ext.bgFrame=null;
    }
    const bgFrame=document.createElement('iframe');
    bgFrame.style.cssText='position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;z-index:-1;';
    bgFrame.setAttribute('sandbox','allow-scripts allow-same-origin');
    document.body.appendChild(bgFrame);
    ext.bgFrame=bgFrame;
    const shimCode=buildChromeShim(extId,null,true);
    if (bgInfo.type==='page') {
        const htmlContent=await readExtFileText(extId,bgInfo.page);
        if (!htmlContent) return;
        const injected=htmlContent.replace(
            /(<head[^>]*>)/i,
            `$1<script>${shimCode}<\/script>`
        );
        const rewritten=await rewriteExtHtml(extId, injected);
        const blob=new Blob([rewritten],{type:'text/html'});
        bgFrame.src=URL.createObjectURL(blob);
    } else if (bgInfo.type==='scripts') {
        let scriptTags='';
        for (const scriptPath of bgInfo.scripts) {
            const code=await readExtFileText(extId,scriptPath);
            if (code) scriptTags+=`<script>${await wrapExtScript(extId,code)}<\/script>\n`;
        }
        const html=`<!DOCTYPE html><html><head>
        <script>${shimCode}</script>
        ${scriptTags}
        </head><body></body></html>`;
        const blob=new Blob([html],{type:'text/html'});
        bgFrame.src=URL.createObjectURL(blob);
    } else if (bgInfo.type==='worker') {
        bgFrame.remove();
        ext.bgFrame=null;
        const code=await readExtFileText(extId,bgInfo.script);
        if (!code) return;
        const workerCode=shimCode+'\n'+await wrapExtScript(extId,code);
        const blob=new Blob([workerCode],{type:'application/javascript'});
        const workerUrl=URL.createObjectURL(blob);
        try {
            const worker=new Worker(workerUrl);
            ext.bgWorker=worker;
            worker.addEventListener('message',(e)=>{
                handleShimMessage({data:e.data,source:{postMessage:(msg)=>worker.postMessage(msg)}});
            });
        } catch (e) {
            console.warn('[amethyst] worker start failed, falling back to iframe: ',e);
        }
    }
    
    bgFrame?.addEventListener('load',()=>{
        setTimeout(()=>{
            fireEvent2Ext(extId,'runtime.onInstalled',[{reason:'install'}]);
            fireEvent2Ext(extId,'runtime.onStartup',[]);
        },100);
    });
}

function fireEvent2Ext(extId,eventName,args) {
    const ext=_extensions[extId];
    if (!ext) return;
    const target =ext.bgFrame?.contentWindow||null;
    if (!target) return;
    try {
        target.postMessage({
            __amethyst_reply:true,extId,tabId:null,msgId:null,
            event:eventName,args
        },'*');
    } catch (e) {}
}

