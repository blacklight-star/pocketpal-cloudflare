import {makeAutoObservable, runInAction} from 'mobx';
import * as Keychain from 'react-native-keychain';

/**
 * PocketPal talks only to the L1 gateway. The L1 Worker owns the L1→L2
 * bridge credentials; neither Cloudflare account token is stored on-device.
 */
export const CLOUDFLARE_ADMIN_ENDPOINT =
  'https://personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute';

const keychainService = 'cloudflare_admin_gateway_v1';

class CloudflareAdminStore {
  private gatewayKey = '';
  private keyLoaded = false;

  constructor() {
    makeAutoObservable(this, {}, {autoBind: true});
    this.loadKey();
  }

  get isKeyLoaded(): boolean {
    return this.keyLoaded;
  }

  get hasGatewayKey(): boolean {
    return this.gatewayKey.trim().length > 0;
  }

  getGatewayKey(): string {
    return this.gatewayKey;
  }

  private async loadKey(): Promise<void> {
    try {
      const credentials = await Keychain.getGenericPassword({
        service: keychainService,
      });
      runInAction(() => {
        this.gatewayKey = credentials?.password ?? '';
        this.keyLoaded = true;
      });
    } catch (error) {
      runInAction(() => {
        this.gatewayKey = '';
        this.keyLoaded = true;
      });
      console.error('Failed to load Cloudflare gateway credential:', error);
    }
  }

  async setGatewayKey(value: string): Promise<boolean> {
    const key = value.trim();
    if (!key) {
      return false;
    }
    try {
      await Keychain.setGenericPassword('pocketpal-cloudflare', key, {
        service: keychainService,
      });
      runInAction(() => {
        this.gatewayKey = key;
        this.keyLoaded = true;
      });
      return true;
    } catch (error) {
      console.error('Failed to save Cloudflare gateway credential:', error);
      return false;
    }
  }

  async clearGatewayKey(): Promise<boolean> {
    try {
      await Keychain.resetGenericPassword({service: keychainService});
      runInAction(() => {
        this.gatewayKey = '';
        this.keyLoaded = true;
      });
      return true;
    } catch (error) {
      console.error('Failed to clear Cloudflare gateway credential:', error);
      return false;
    }
  }
}

export const cloudflareAdminStore = new CloudflareAdminStore();
export {CloudflareAdminStore};
