import { PersonalPageStoreSync } from './PersonalPageStore.sync';
import { StorageUtil } from './LocalStorageUtil';
import type { IPersonalPageSDK } from './PersonalPageStore.types';
class PersonalPageStore extends PersonalPageStoreSync {
  static override debug = false;
  static override _log(...args: unknown[]): void {
    if (PersonalPageStore.debug) console.log(...args);
  }
  constructor(sdk: IPersonalPageSDK) { super(sdk); }
}
if (typeof window !== 'undefined') {
  (window as Window & { PersonalPageStore?: typeof PersonalPageStore }).PersonalPageStore = PersonalPageStore;
}
export default PersonalPageStore;
export { StorageUtil };
export type { IPersonalPageSDK } from './PersonalPageStore.types';
export type { MountedFolder, SearchPath, PageMetadata, VersionConflictEvent } from './PersonalPageStore.types';