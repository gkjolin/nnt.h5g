// 对egret的RES模块进行功能扩展
module RES {
    
    class ExtResourceItem
    extends ResourceItem
    {
        constructor(name: string, url: string, type: string) {
            super(name, url, type);
        }

        _priority:nn.ResPriority = nn.ResCurrentPriority;
    }

    class ExtLazyLoadList
    {
        push(item:ExtResourceItem) {
            let arr = this.items[item._priority];
            arr.push(item);
            ++this.length;
        }
        
        pop():ExtResourceItem {
            if (this.length == 0)
                return null;
            let arr = this.items[nn.ResPriority.NORMAL];
            let poped = arr.pop();
            if (poped == null) {
                arr = this.items[nn.ResPriority.CLIP];
                poped = arr.pop();
            }
            --this.length;
            return poped;
        }

        length:number = 0;

        // 不通的等级定义不同的队列
        items:Array<Array<ExtResourceItem> > = [
            new Array<ExtResourceItem>(),
            new Array<ExtResourceItem>()
        ];
    }    

    RES.ResourceItem = ExtResourceItem;

    // 使用ext换掉原来的lazy以提供附加的优先级控制
    let lazyLoadListChanged:boolean;
    let PROTO = ResourceLoader.prototype;
    let funcLoadItem = PROTO.loadItem;
    PROTO.loadItem = function (resItem:ResourceItem) {
        let self:any = this;
        if (!lazyLoadListChanged) {
            if (self.lazyLoadList == null)
                nn.fatal("Egret引擎升级RES的LazyLoadList方法，请检查引擎修改");
            self.lazyLoadList = new ExtLazyLoadList();
            lazyLoadListChanged = true;
        }
        funcLoadItem.call(self, resItem);
    };    
}

module nn {

    export interface ICacheJson
    extends ICacheRecord
    {
        use():any;
    }
    
    export interface ICacheTexture
    extends ICacheRecord
    {
        use():egret.Texture;
    }
    
    export interface ICacheText
    extends ICacheRecord
    {
        use():string;
    }
    
    export interface ICacheFont
    extends ICacheRecord
    {
        use():egret.BitmapFont;
    }
    
    export interface ICacheSound
    extends ICacheRecord
    {
        use():egret.Sound;
    }

    export interface ICacheBinary
    extends ICacheRecord
    {
        use():any;
    }

    // 资源池
    export class _ResMemcache
    extends Memcache
    {
        constructor() {
            super();
            this.enable = true;
        }        
        
        protected doRemoveObject(rcd:CacheRecord) {
            super.doRemoveObject(rcd);
            let srcs = this._sources[rcd.key];
            srcs.forEach((e:string)=>{
                RES.destroyRes(e);
                if (VERBOSE)
                    log("释放资源 " + e);
                delete this._keys[e];
            });
            delete this._sources[rcd.key];
        }

        // 自定义个hashCode
        private _hashCode:number = 0;
        static IDR_HASHCODE = '::mc::hashCode';

        // 根据source添加data
        add(source:string, data:any):ICacheRecord {
            // 根据data的不同计算对应的key
            let key:any;
            if (data == null)
            {
                key = "::mc::null";
            }
            else if ('hashCode' in data)
            {
                key = data.hashCode;
            }
            else if (typeof(data) == 'object')
            {
                key = data[_ResMemcache.IDR_HASHCODE];
                if (key == null) {
                    key = '::mc::' + this._hashCode++;
                    data[_ResMemcache.IDR_HASHCODE] = key;
                }
            }
            else
            {                
                let rcd = new CacheRecord();
                rcd.val = data;
                return rcd;
            }

            let srcs = this._sources[key];
            if (srcs == null) {
                srcs = [source];
                this._sources[key] = srcs;
            } else {
                srcs.push(source);
            }
            this._keys[source] = key;                

            // 添加到缓存中
            let obj = new _ResCacheObject();
            obj.key = key;
            obj.data = data;
            return this.cache(obj);
        }

        query(source:string):ICacheRecord {
            let key = this._keys[source];
            return super.query(key);
        }
        
        // cache-key 和 sources 的对照表
        private _sources = new KvObject<any, Array<string> >();
        private _keys = new KvObject<string, any>();
    }

    class _ResCacheObject
    implements ICacheObject
    {
        constructor() {}
        
        cacheFlush:boolean = true;
        cacheUpdated:boolean = true;
        cacheTime:number = -1;

        keyForCache():string {
            return this.key;
        }
        
        valueForCache():any {
            return this.data;
        }
        
        data:any;
        key:any;        
    }

    export class ResCapsule
    extends CResCapsule
    {
        constructor(reqres:ReqResource[], ewd:EventWeakDispatcher) {
            super(reqres);
            this._ewd = ewd;
        }

        dispose() {
            this._ewd = undefined;
            super.dispose();
        }

        // 用来从 ResManager 里拿到消息
        private _ewd:EventWeakDispatcher;        
        
        protected loadOne(rr:ReqResource,
                          cb:()=>void, ctx:any)
        {
            let curidx = 0;
            // 判断是加载资源组，还是直接加载资源
            if (rr instanceof ResourceEntity)
            {
                let re = <ResourceEntity>rr;
                ResManager.getSourceByType(re.source, ResPriority.NORMAL, (rcd:ICacheRecord)=>{
                    if (this.signals.isConnected(SignalChanged)) {
                        curidx = 1;
                        this._idx += 1;
                        // 发出消息
                        this.signals.emit(SignalChanged, new Percentage(this._total, this._idx));
                    }
                    cb.call(ctx);
                }, this, re.type);
            }
            else
            {
                let grp = <ResourceGroup>rr;
                if (RES.isGroupLoaded(grp)) {
                    if (this.signals.isConnected(SignalChanged)) {
                        let len = RES.getGroupByName(grp).length;
                        curidx = len;
                        this._idx += len;
                        this.signals.emit(SignalChanged, new Percentage(this._total, this._idx));
                    }
                    cb.call(ctx);
                } else {
                    this._ewd.add("::res::group::" + grp, cb, ctx);
                    if (this.signals.isConnected(SignalChanged)) {
                        this._ewd.add("::res::group::progress::" + grp, (e:RES.ResourceEvent)=>{
                            // 计算进度
                            let delta = e.itemsLoaded - curidx;
                            curidx = e.itemsLoaded;
                            this._idx += delta;
                            // 发出消息
                            this.signals.emit(SignalChanged, new Percentage(this._total, this._idx));
                        }, this);
                    }
                    RES.loadGroup(grp);
                }
            }
        }

        protected total():number {
            let r = 0;
            this._reqRes.forEach((rr:ReqResource)=>{
                if (rr instanceof ResourceEntity)
                    r += 1;
                else
                    r += RES.getGroupByName(<ResourceGroup>rr).length;
            });
            return r;
        }
        
    }

    let EgretItemTypeMap = {};
    EgretItemTypeMap[ResType.JSON] = RES.ResourceItem.TYPE_JSON;
    EgretItemTypeMap[ResType.TEXTURE] = RES.ResourceItem.TYPE_IMAGE;
    EgretItemTypeMap[ResType.TEXT] = RES.ResourceItem.TYPE_TEXT;
    EgretItemTypeMap[ResType.FONT] = RES.ResourceItem.TYPE_FONT;
    EgretItemTypeMap[ResType.SOUND] = RES.ResourceItem.TYPE_SOUND;
    EgretItemTypeMap[ResType.BINARY] = RES.ResourceItem.TYPE_BIN;

    export class _ResManager
    extends CResManager
    {
        constructor() {
            super();

            // config 只在manager中处理，其他事件转到包中处理
            RES.addEventListener(RES.ResourceEvent.CONFIG_COMPLETE,
                                 this._cfg_loaded, this);
            
            RES.addEventListener(RES.ResourceEvent.GROUP_COMPLETE,
                                 this._grp_complete, this);
            RES.addEventListener(RES.ResourceEvent.GROUP_LOAD_ERROR,
                                 this._grp_failed, this);
            RES.addEventListener(RES.ResourceEvent.GROUP_PROGRESS,
                                 this._grp_progress, this);

            // 切换为4线程下载资源
            RES.setMaxLoadingThread(4);
        }
        
        // 用来转发事件
        private _ewd = new EventWeakDispatcher();

        // 资源的缓存管理
        cache = new _ResMemcache();

        loadConfig(file:string, cb:(e:any)=>void, ctx:any) {
            this._ewd.add("::res::config", cb, ctx);
            // 如过file是绝对地址，则不添加directory
            if (file.indexOf('://') == -1)
                file = this.directory + file;
            RES.loadConfig(file,
                           this.directory);
        }

        get cacheEnabled():boolean {
            return this.cache.enable;
        }
        set cacheEnabled(v:boolean) {
            this.cache.enable = v;
        }        

        private _cfg_loaded(e:RES.ResourceEvent) {
            let idr = "::res::config";
            this._ewd.invoke(idr, e, false);
            this._ewd.remove(idr);
        }

        private _grp_complete(e:RES.ResourceEvent) {            
            let idr0 = "::res::group::" + e.groupName;
            let idr1 = "::res::group::progress::" + e.groupName;
            this._ewd.invoke(idr0, e, false);
            this._ewd.remove(idr0);
            this._ewd.remove(idr1);
        }

        private _grp_failed(e:RES.ResourceEvent) {
            this._grp_complete(e);
        }

        private _grp_progress(e:RES.ResourceEvent) {
            let item = e.resItem;

            // 增加其他数据文件
            if (item.type == RES.ResourceItem.TYPE_BIN) {
                // 增加字体
                if (FontFilePattern.test(item.url)) {
                    FontsManager.add(item.name, item.url);
                }
            }
            
            let idr = "::res::group::progress::" + e.groupName;            
            this._ewd.invoke(idr, e, false);
        }

        isGroupsArrayLoaded(grps:string[]):boolean {
            if (grps) {
                for (let i = 0; i < grps.length; ++i) {
                    if (RES.isGroupLoaded(grps[i]) == false)
                        return false;
                }
            }
            return true;
        }

        // 正在加载的资源包
        private _capsules = new KvObject<number, CResCapsule>();

        capsules(grps:ReqResource[]):CResCapsule {
            let k = ResCapsule.HashKey(grps);
            let cp:ResCapsule = this._capsules[k];
            if (cp == null) {
                cp = new ResCapsule(grps, this._ewd);
                this._capsules[k] = cp;
            }
            return cp;
        }

        removeCapsule(cp:CResCapsule) {
            let k = cp.hashKey();
            cp.drop();
            delete this._capsules[k];
        }

        tryGetRes(key:string):ICacheRecord {
            let rcd = this.cache.query(key);
            if (rcd == null) {
                let d = RES.getRes(key);
                if (d) {
                    rcd = this.cache.add(key, d);
                } else {
                    return new CacheRecord();
                }
            }
            return rcd;
        }

        getResAsync(key:string, priority:ResPriority,
                    cb:(rcd:ICacheRecord)=>void, ctx?:any)
        {
            if (length(key) == 0) {
                cb.call(ctx, new CacheRecord());
                return;
            }
            let rcd = this.cache.query(key);
            if (rcd == null) {
                ResCurrentPriority = priority;
                RES.getResAsync(key, (d:any)=>{
                    if (d) {
                        rcd = this.cache.add(key, d);
                    } else {
                        rcd = new CacheRecord();
                        warn("res " + key + " not found");
                    }
                    cb.call(ctx, rcd);
                }, this);
            } else {
                cb.call(ctx, rcd);
            }
        }

        if (DEBUG) {
            if ((<any>RES).configInstance == undefined)
                fatal('ResManager 存在兼容问题');
        }

        getResUrl(key:string):string {
            let obj = (<any>RES).configInstance.keyMap[key];
            if (obj == null) {
                warn("res " + key + " not found");
                return null;
            }
            return obj.url;
        }

        getResByUrl(src:UriSource, priority:ResPriority,
                    cb:(rcd:ICacheRecord|CacheRecord)=>void, ctx:any, type:ResType)
        {            
            // 如果位于缓存中，则直接返回
            let rcd = this.cache.query(src);
            if (rcd != null) {
                cb.call(ctx, rcd);
                return;
            }

            // 不在缓存中，需要直接获得
            ResCurrentPriority = priority;
            RES.getResByUrl(src, (d:any)=>{
                // 添加到缓存
                rcd = this.cache.add(src, d);
                // 回调
                cb.call(ctx, rcd);
            }, this, EgretItemTypeMap[type]);
        }

        hasAsyncUri(uri:UriSource):boolean {
            return this.cache.query(uri) != null;
        }

        getTexture(src:TextureSource, priority:ResPriority,
                   cb:(tex:ICacheTexture)=>void, ctx:any):void
        {
            if (<any>src instanceof COriginType) {
                let t = new CacheRecord();
                t.val = (<COriginType>src).imp;
                cb.call(ctx, t);
                return;
            }
            if (<any>src instanceof egret.Texture) {
                let t = new CacheRecord();
                t.val = src;
                cb.call(ctx, t);
                return;
            }
            this.getSourceByType(<string>src, priority, cb, ctx, ResType.TEXTURE);
        }

        getBitmapFont(src:FontSource, priority:ResPriority,
                      cb:(fnt:ICacheFont)=>void, ctx:any)
        {
            if (<any>src instanceof COriginType) {
                let t = new CacheRecord();
                t.val = (<COriginType>src).imp;
                cb.call(ctx, t);
                return;
            }
            if (<any>src instanceof egret.BitmapFont) {
                let t = new CacheRecord();
                t.val = src;
                cb.call(ctx, t);
                return;
            }
            // 通过配置来获得
            if (<any>src instanceof FontConfig) {
                let cfg = <FontConfig>src;
                if (cfg.name) {
                    this.getSourceByType(cfg.name, priority, cb, ctx, ResType.FONT);
                } else {
                    // 通过两个配置文件来获得
                    this.getSources([[cfg.texture, ResType.TEXTURE],
                                     [cfg.config, ResType.JSON]],
                                    priority, 
                                    (ds:ICacheRecord[])=>{
                                        let tex:ICacheTexture = ds[0];
                                        let cfg:ICacheJson = ds[1];
                                        // todo 现在为简化font缓存处理(直接调用use逻辑避免tex和cfg被释放)
                                        let t = new CacheRecord();
                                        t.val = new egret.BitmapFont(tex.use(), cfg.use());
                                        cb.call(ctx, t);
                                    }, this);
                }
                return;
            }
            // 通过key来获得
            this.getSourceByType(<string>src, priority, cb, ctx, ResType.FONT);
        }

        getSound(src:SoundSource, priority:ResPriority,
                 cb:(snd:ICacheSound)=>void, ctx:any)
        {
            if (<any>src instanceof COriginType) {
                let t = new CacheRecord();
                t.val = (<COriginType>src).imp;
                cb.call(ctx, t);
                return;
            }
            if (<any>src instanceof egret.Sound) {
                let t = new CacheRecord();
                t.val = src;
                cb.call(ctx, t);
                return;
            }
            this.getSourceByType(<string>src, priority, cb, ctx, ResType.SOUND);
        }
    }

    ResManager = new _ResManager();

}
