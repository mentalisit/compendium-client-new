import EventEmitter from 'events';
import { CompendiumApiClient, CorpData, Guild, Identity, SyncData, TechLevels, User, UserCorporations } from './bot_api';
import { getTechFromIndex } from './module_types';

/*
This class encapsulates the bot api functionality with persistence in
local storage and provides a simpler interface for front ends.
*/
const REFRESH_MS = 5 * 60 * 1000;

const STORAGE_KEY = 'hscompendium';

type StorageData = {
  ident: Identity;
  userData: Record<string, SyncData>;
  refresh: number;
  tokenRefresh: number;
};

export class Compendium extends EventEmitter {
    public client: CompendiumApiClient;

    private ident: Identity | null = null;

    private lastRefresh: number = 0;

    private lastTokenRefresh: number = 0;

    private syncData: Record<string, SyncData> | null = null;

    private timer: any = null;

    public selectedAlt: string = 'default';

    constructor(url: string = 'https://compendiumnew.mentalisit.myds.me/compendium') {
        super();
        this.client = new CompendiumApiClient(url);
    }

    public getUser(): User | undefined {
        return this.ident?.user;
    }

    public getGuild(): Guild | undefined {
        return this.ident?.guild;
    }

    public getTechLevels(): TechLevels | undefined {
        if (this.ident) {
            const alt = this.GetNameAlt();
            if (this.syncData && this.syncData[alt]) {
                return this.syncData[alt].techLevels;
            }
        }
        return undefined;
    }

    public async initialize() {
        this.ident = this.readStorage(); // Получаем ident напрямую из хранилища
        if (this.ident) {
            const alt = this.GetNameAlt();

            if (!this.syncData) {
                this.syncData = {};
            }
            if (!this.syncData[alt]) {
                this.syncData[alt] = { ver: 1, inSync: 1, techLevels: {} };
            }

            const hasData = Object.keys(this.syncData[alt].techLevels).length > 0;

            await this.syncUserData(hasData ? 'sync' : 'get');
            if (!hasData) {
                this.ident = await this.client.refreshConnection(this.ident.token);
                this.lastTokenRefresh = Date.now();
                this.writeStorage();
            }

            this.emit('connected', this.ident);
        }
        // Настройка таймера для регулярной проверки
        this.timer = setInterval(() => this.tick(), REFRESH_MS);
    }


    public shutdown() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /*
  Get the code based identity - this should be presented to user to verify, and the value passed to connect()
  to make the connection
  */
    public async checkConnectCode(code: string): Promise<Identity> {
        return this.client.checkIdentity(code);
    }

    public async connect(ident: Identity): Promise<Identity> {
        this.clearData();
        this.ident = await this.client.connect(ident);
        this.emit('connected', this.ident);

        this.lastTokenRefresh = Date.now();
        this.writeStorage();

        await this.syncUserData('get');
        return this.ident;
    }

    public logout() {
        this.emit('disconnected');
        this.clearData();
    }

    public async corpdata(params?: { corpId?: string | null, roleId?: string | null }): Promise<CorpData> {
        if (!this.ident) {
            throw new Error('not connected');
        }

        let queryParams = '';
        if (params?.corpId !== undefined && params.corpId !== null) {
            queryParams = `?corpId=${params.corpId}`;
        } else if (params?.roleId !== undefined && params.roleId !== null) {
            queryParams = `?roleId=${params.roleId}`;
        }

        const rv = await fetch(`${this.client.getUrl()}/cmd/corpdata${queryParams}`, {
            headers: {
                "Content-Type": "application/json",
                Authorization: this.ident.token,
            },
        });
        if (rv.status < 200 || rv.status >= 500) {
            throw new Error("Server Error");
        }
        const obj = await rv.json();
        if (rv.status >= 400) {
            throw new Error(obj.error);
        }
        return obj;
    }

    public async getUserCorporations(): Promise<UserCorporations> {
        if (!this.ident) {
            throw new Error('not connected');
        }

        const rv = await fetch(`${this.client.getUrl()}/user/corporations`, {
            headers: {
                "Content-Type": "application/json",
                Authorization: this.ident.token,
            },
        });
        if (rv.status < 200 || rv.status >= 500) {
            throw new Error("Server Error");
        }
        const obj = await rv.json();
        if (rv.status >= 400) {
            throw new Error(obj.error);
        }
        return obj;
    }

    public async setTechLevel(techId: number, level: number): Promise<void> {
        if (!this.ident) {
            throw new Error('not connected');
        }
        if (getTechFromIndex(techId) === '') {
            throw new Error('Invalid tech id');
        }
        const alt = this.GetNameAlt();

        if (!this.syncData) {
            this.syncData = {};
        }

        if (!this.syncData[alt]) {
            this.syncData[alt] = { ver: 1, inSync: 1, techLevels: {} };
        }

        this.syncData[alt].techLevels[techId] = { level, ts: Date.now() };

        await this.syncUserData('sync');
    }


    private writeStorage() {
        if (!this.ident) {
            return;
        }
        const data: StorageData = {
            ident: this.ident,
            userData: this.syncData ?? { 'default': { ver: 1, inSync: 1, techLevels: {} } },
            refresh: this.lastRefresh,
            tokenRefresh: this.lastTokenRefresh,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    private readStorage(): Identity | null {
        const raw = localStorage.getItem(STORAGE_KEY);
        // Validate identity. Reasonable defaults elsewhere
        if (!raw) {
            this.clearData();
            return null;
        } else {
            try {
                const stored = JSON.parse(raw);
                if (stored && stored.ident) {
                    this.ident = stored.ident;
                    this.syncData = stored.syncData ?? { 'default': { ver: 1, inSync: 1, techLevels: {} } };
                    this.lastRefresh = Number(stored.refresh ?? 0);
                    this.lastTokenRefresh = Number(stored.lastTokenRefresh ?? 0);
                    return this.ident;
                } else {
                    throw new Error('Data corrupt');
                }
            } catch (e) {
                // if there was data and it failed to parse, emit a connectfailed
                this.clearData();
                this.emit('connectfailed', (e as Error).message);
                return null;
            }
        }
    }

    private clearData() {
        localStorage.removeItem(STORAGE_KEY);
        this.ident = null;
        this.lastTokenRefresh = 0;
        this.lastRefresh = 0;
        this.syncData = null;
    }

    private async syncUserData(mode: string): Promise<void> {
        const alt = this.GetNameAlt();

        if (!this.ident) {
            throw new Error('Cannot sync user data - not connected');
        }
        if (!this.syncData) {
            this.syncData = {};
        }
        if (!this.syncData[alt]) {
            this.syncData[alt] = { ver: 1, inSync: 1, techLevels: {} };
        }

        try {
            // Выполнение синхронизации с сервером
            this.syncData[alt] = await this.client.sync(alt, this.ident.token, mode, this.syncData[alt].techLevels ?? {});

            // Обновление времени последней синхронизации и запись в локальное хранилище
            this.lastRefresh = Date.now();
            this.writeStorage();

            // Отправка события синхронизации
            this.emit('sync', this.syncData[alt].techLevels);
        } catch (error) {
            console.error('Error syncing data:', error);
            throw new Error(`Failed to sync data: ${ error}`);
        }
    }

    private GetNameAlt(): string {
        return this.selectedAlt;
    }

    public switchAlt(alt: string) {
        this.selectedAlt = alt;
        this.syncUserData('get');
    }


    private async tick() {
        if (this.ident) {
            // if (Date.now() - this.lastTokenRefresh > 7776000000) {
            //   // three months - this is unlikely to occur in a browser environment
            //   // but may occur in a hybrid mobile app
            //   try {
            //     this.ident = await this.client.refreshConnection(this.ident.token);
            //     this.lastTokenRefresh = Date.now();
            //     this.writeStorage();
            //   } catch (e) {
            //     this.clearData();
            //     this.emit("connectfailed", (e as Error).message);
            //     throw e;
            //   }
            // }
            if (Date.now() - this.lastRefresh > REFRESH_MS) {
                await this.syncUserData('sync');
            }
        }
    }
}
