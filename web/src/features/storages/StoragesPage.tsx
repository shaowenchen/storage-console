import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { confirm, notify, notifyError } from '../../shared/components/AppNotice';
import { ListRailHeader } from '../../shared/components/ListRailHeader';
import { ListItemActionMenu } from '../../shared/components/ListItemActionMenu';
import { MoveObjectModal } from '../../shared/components/MoveObjectModal';
import { useRailCollapsed } from '../../shared/components/useRailCollapsed';
import { UploadModal } from '../../shared/components/UploadModal';
import { useListingCache } from '../../shared/hooks/useListingCache';
import { copyToClipboard, objectAbsoluteKey, objectRelativePath } from '../../shared/format';
import { requestErrorMessage } from '../../shared/requestError';
import { getDownloadKey, storageDownloadScriptUrl } from '../../shared/upload/api';
import { downloadRunCommand } from '../../shared/upload/helpers';
import {
  deleteStorage,
  deleteStorageObject,
  getDownloadLink,
  getObjectAccess,
  listStorageFiles,
  listStorages,
  moveStorageObject,
  setObjectPrivate,
  setObjectPublic,
  testStorage,
} from './api';
import { ObjectFileTable } from './ObjectFileTable';
import { StorageFormModal } from './StorageFormModal';
import type { Storage, StorageFileItem } from './types';
import './storages.css';

const STORAGE_LIST_KEY = 'studio.storageListCollapsed';
const ACL_HYDRATE_CONCURRENCY = 6;

function listingKey(bucketId: string, prefix: string): string {
  return `storage:${bucketId}:${prefix || ''}`;
}

type ObjectAccessPatch = {
  isPublic: boolean;
  publicUrl?: string;
  aclSupported?: boolean;
  aclResolved?: boolean;
};

export function StoragesPage() {
  const [storages, setStorages] = useState<Storage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState<StorageFileItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const { collapsed, toggleCollapsed } = useRailCollapsed(STORAGE_LIST_KEY);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [railMenuOpen, setRailMenuOpen] = useState(false);
  const [modalStorage, setModalStorage] = useState<Storage | null | 'new'>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{
    key: string;
    isPrefix: boolean;
    initialPath: string;
  } | null>(null);

  const listingCache = useListingCache<{
    items: StorageFileItem[];
    nextCursor: string | null;
    prefix: string;
  }>();
  const aclHydrateGen = useRef(0);

  const selectedStorage = storages.find((s) => s.id === selectedId);

  const updateItemAccess = useCallback(
    (key: string, access: ObjectAccessPatch) => {
      setItems((prev) => {
        const next = prev.map((item) =>
          item.key === key
            ? {
                ...item,
                isPublic: access.isPublic,
                publicUrl: access.publicUrl,
                aclSupported: access.aclSupported ?? item.aclSupported,
                aclResolved: access.aclResolved ?? true,
              }
            : item,
        );
        if (selectedId) {
          const cacheKey = listingKey(selectedId, prefix);
          const cached = listingCache.get(cacheKey);
          if (cached) {
            listingCache.set(cacheKey, { ...cached, items: next });
          }
        }
        return next;
      });
    },
    [selectedId, prefix, listingCache],
  );

  const hydrateObjectAcls = useCallback(
    async (bucketId: string, listed: StorageFileItem[]) => {
      const pending = listed.filter((item) => item.type === 'file' && !item.aclResolved);
      if (!pending.length) return;
      const gen = ++aclHydrateGen.current;
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          if (aclHydrateGen.current !== gen) return;
          const item = pending[cursor++];
          try {
            const access = await getObjectAccess(bucketId, item.key);
            if (aclHydrateGen.current !== gen) return;
            updateItemAccess(item.key, { ...access, aclResolved: true });
          } catch {
            if (aclHydrateGen.current !== gen) return;
            updateItemAccess(item.key, {
              isPublic: false,
              aclSupported: true,
              aclResolved: true,
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(ACL_HYDRATE_CONCURRENCY, pending.length) }, () => worker()),
      );
    },
    [updateItemAccess],
  );

  async function refreshItemAccess(key: string) {
    if (!selectedId) return;
    try {
      const access = await getObjectAccess(selectedId, key);
      updateItemAccess(key, { ...access, aclResolved: true });
    } catch {
      /* ignore ACL refresh errors */
    }
  }

  const loadStorages = useCallback(async () => {
    setLoadingList(true);
    try {
      const data = await listStorages();
      setStorages(data);
      const stillSelected = selectedId && data.some((s) => s.id === selectedId);
      if (stillSelected) return;
      const firstId = data[0]?.id ?? null;
      setSelectedId(firstId);
      setPrefix('');
      setItems([]);
      setNextCursor(null);
    } catch (err) {
      notifyError(requestErrorMessage(err, 'Failed to load storages'), 'Failed to load storages');
    } finally {
      setLoadingList(false);
    }
  }, [selectedId]);

  const loadFiles = useCallback(
    async (force = false) => {
      if (!selectedId) return;
      const cacheKey = listingKey(selectedId, prefix);
      if (!force) {
        const cached = listingCache.get(cacheKey);
        if (cached) {
          setItems(cached.items);
          setNextCursor(cached.nextCursor);
          void hydrateObjectAcls(selectedId, cached.items);
          return;
        }
      }
      setLoadingFiles(true);
      try {
        const data = await listingCache.fetchCached(
          cacheKey,
          async () => {
            const res = await listStorageFiles(selectedId, prefix);
            return {
              items: res.items || [],
              nextCursor: res.nextCursor || null,
              prefix: res.prefix ?? prefix,
            };
          },
          force,
        );
        setItems(data.items);
        setNextCursor(data.nextCursor);
        void hydrateObjectAcls(selectedId, data.items);
      } catch (err) {
        setItems([]);
        setNextCursor(null);
        const message = requestErrorMessage(err, 'Failed to load files');
        if (message.includes('failed recently')) return;
        notifyError(message, 'Failed to load storage objects');
      } finally {
        setLoadingFiles(false);
      }
    },
    [selectedId, prefix, listingCache, hydrateObjectAcls],
  );

  useEffect(() => {
    void loadStorages();
  }, [loadStorages]);

  useEffect(() => {
    if (selectedId) void loadFiles();
  }, [selectedId, prefix, loadFiles]);

  async function onLoadMore() {
    if (!selectedId || !nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await listStorageFiles(selectedId, prefix, nextCursor);
      const newItems = data.items || [];
      setItems((prev) => {
        const merged = [...prev, ...newItems];
        listingCache.set(listingKey(selectedId, prefix), {
          items: merged,
          nextCursor: data.nextCursor || null,
          prefix,
        });
        return merged;
      });
      const cursor = data.nextCursor || null;
      setNextCursor(cursor);
      void hydrateObjectAcls(selectedId, newItems);
    } catch {
      notifyError('Failed to load more files');
    } finally {
      setLoadingMore(false);
    }
  }

  async function onDeleteStorage(storage: Storage) {
    if (
      !(await confirm(
        `Move storage "${storage.name}" to Trash? Studio file records will move with it.`,
      ))
    )
      return;
    try {
      await deleteStorage(storage.id);
      listingCache.invalidateAll();
      if (selectedId === storage.id) {
        setSelectedId(null);
        setItems([]);
      }
      await loadStorages();
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Failed to delete storage');
    }
  }

  async function onTestStorage(storage: Storage) {
    try {
      await testStorage(storage.id);
      notify(`Storage "${storage.name}" connection test succeeded.`);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Connection failed');
    }
  }

  async function onDownload(key: string) {
    if (!selectedId) return;
    try {
      const { url } = await getDownloadLink(selectedId, key);
      window.location.href = url;
    } catch {
      notifyError('Download failed');
    }
  }

  async function onCopyLink(item: StorageFileItem) {
    if (!selectedId) return;
    if (item.isPublic && item.publicUrl) {
      const copied = await copyToClipboard(item.publicUrl);
      notify(
        copied
          ? `Public path copied:\n${item.publicUrl}`
          : `Copy failed. Public path:\n${item.publicUrl}`,
      );
      return;
    }
    try {
      const { url, expiresInSeconds } = await getDownloadLink(selectedId, item.key);
      const minutes = Math.max(1, Math.round((expiresInSeconds || 900) / 60));
      const copied = await copyToClipboard(url);
      notify(
        copied
          ? `Direct download link copied. Valid for ~${minutes} min:\n${url}`
          : `Copy failed. Direct download link (valid ~${minutes} min):\n${url}`,
      );
    } catch {
      notifyError('Failed to create download link');
    }
  }

  async function onCopyDownloadCli(item: StorageFileItem) {
    if (!selectedId) return;
    try {
      const key = await getDownloadKey();
      const endpoint = storageDownloadScriptUrl(selectedId, item.key);
      const cmd = downloadRunCommand(endpoint, key);
      const copied = await copyToClipboard(cmd);
      notify(
        copied
          ? `Direct download CLI copied.\n${cmd}`
          : `Copy failed. Select and copy manually:\n${cmd}`,
      );
    } catch {
      notifyError('Failed to create download CLI command');
    }
  }

  function openMoveModal(key: string, isPrefix: boolean) {
    if (!selectedStorage) return;
    const currentRelative = objectRelativePath(selectedStorage.bucketPath, key).replace(/\/$/g, '');
    setMoveTarget({ key, isPrefix, initialPath: currentRelative });
  }

  async function confirmMove(targetRelative: string) {
    if (!moveTarget || !selectedId || !selectedStorage) {
      throw new Error('Move target is not available');
    }
    const targetKey = objectAbsoluteKey(selectedStorage.bucketPath, targetRelative);
    await moveStorageObject(selectedId, moveTarget.key, targetKey, moveTarget.isPrefix);
    listingCache.invalidate((k) => k.startsWith(`storage:${selectedId}:`));
    await loadFiles(true);
  }

  async function onMove(key: string, isPrefix: boolean) {
    openMoveModal(key, isPrefix);
  }

  async function onDropMove(sourceKey: string, targetFolder: StorageFileItem) {
    if (!selectedId || !selectedStorage) return;
    const fileName = sourceKey.split('/').filter(Boolean).pop() || sourceKey;
    const folderRel = String(targetFolder.relativePath || '').replace(/\/+$/g, '');
    const targetRelative = folderRel ? `${folderRel}/${fileName}` : fileName;
    const targetKey = objectAbsoluteKey(selectedStorage.bucketPath, targetRelative);
    if (targetKey === sourceKey) return;
    try {
      await moveStorageObject(selectedId, sourceKey, targetKey, false);
      listingCache.invalidate((k) => k.startsWith(`storage:${selectedId}:`));
      await loadFiles(true);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Failed to move object');
    }
  }

  async function onSetPublic(key: string, isPrefix: boolean) {
    if (!selectedId) return;
    const message = isPrefix
      ? `Make all objects under "${key}" public (recursive)? Anyone with the URLs may be able to access them.`
      : `Make "${key}" public? Anyone with the URL may be able to access it.`;
    if (!(await confirm(message))) return;
    try {
      await setObjectPublic(selectedId, key, isPrefix);
      listingCache.invalidate((k) => k.startsWith(`storage:${selectedId}:`));
      if (isPrefix) await loadFiles(true);
      else await refreshItemAccess(key);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Failed to set public');
    }
  }

  async function onSetPrivate(key: string, isPrefix: boolean) {
    if (!selectedId) return;
    if (isPrefix && !(await confirm(`Make all objects under "${key}" private (recursive)?`))) {
      return;
    }
    try {
      await setObjectPrivate(selectedId, key, isPrefix);
      listingCache.invalidate((k) => k.startsWith(`storage:${selectedId}:`));
      if (isPrefix) await loadFiles(true);
      else await refreshItemAccess(key);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Failed to set private');
    }
  }

  async function onDeleteObject(key: string, isPrefix: boolean) {
    if (!selectedId) return;
    if (!(await confirm(`Delete "${key}"? This cannot be undone.`))) return;
    try {
      await deleteStorageObject(selectedId, key, isPrefix);
      listingCache.invalidate((k) => k.startsWith(`storage:${selectedId}:`));
      await loadFiles(true);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Failed to delete object');
    }
  }

  function renderBreadcrumbs() {
    if (!selectedStorage) return null;
    const baseParts = String(selectedStorage.bucketPath || '')
      .split('/')
      .filter(Boolean);
    const relativeParts = prefix.split('/').filter(Boolean);
    const displayParts = [...baseParts, ...relativeParts];

    const crumbs = displayParts.map((part, index) => {
      const relativeIndex = index - baseParts.length;
      const targetPrefix =
        relativeIndex < 0 ? '' : relativeParts.slice(0, relativeIndex + 1).join('/');
      return { label: part, prefix: targetPrefix, isLast: index === displayParts.length - 1 };
    });

    return (
      <div className="browser-path">
        <button
          type="button"
          className={`path-crumb ${displayParts.length ? '' : 'current'}`}
          onClick={() => setPrefix('')}
        >
          Root
        </button>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`}>
            <span className="path-separator">/</span>
            <button
              type="button"
              className={`path-crumb ${crumb.isLast ? 'current' : ''}`}
              onClick={() => setPrefix(crumb.prefix)}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <span className="browser-path-spacer" />
        <button type="button" className="action-btn" onClick={() => setUploadOpen(true)}>
          Upload
        </button>
        <button type="button" className="action-btn" onClick={() => void loadFiles(true)}>
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="page-storages">
      <div className={`storage-layout ${collapsed ? 'storage-list-collapsed' : ''}`}>
        <div className="bucket-panel">
          <ListRailHeader
            title="Storages"
            collapsedLabel="▤"
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            menuOpen={railMenuOpen}
            onMenuOpenChange={setRailMenuOpen}
            menuLabel="Storage actions"
            headerClassName="bucket-list-header"
            titleClassName="bucket-list-title"
            toggleClassName="storage-list-toggle"
            toggleTitle={collapsed ? 'Expand storage list' : 'Collapse storage list'}
            menuChildren={
              <button
                type="button"
                className="bucket-action"
                onClick={() => {
                  setRailMenuOpen(false);
                  setModalStorage('new');
                }}
              >
                Add Storage
              </button>
            }
          />
          <div id="bucket-list">
            {loadingList ? <p className="muted">Loading…</p> : null}
            {!loadingList && !storages.length ? (
              <p className="muted">No storages configured.</p>
            ) : null}
            {storages.map((storage) => (
              <div
                key={storage.id}
                className={`bucket-item ${storage.id === selectedId ? 'active' : ''}`}
                onClick={() => {
                  if (selectedId === storage.id) return;
                  setSelectedId(storage.id);
                  setPrefix('');
                  setOpenMenuId(null);
                }}
              >
                <ListItemActionMenu
                  menuId={storage.id}
                  openMenuId={openMenuId}
                  onOpenMenuChange={setOpenMenuId}
                  menuClassName="bucket-actions show"
                  buttonLabel="Storage actions"
                  header={
                    <span className="bucket-item-name" title={storage.name}>
                      {storage.name}
                    </span>
                  }
                >
                  <button
                    type="button"
                    className="bucket-action"
                    onClick={() => {
                      setOpenMenuId(null);
                      void onTestStorage(storage);
                    }}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className="bucket-action"
                    onClick={() => {
                      setOpenMenuId(null);
                      setModalStorage(storage);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="bucket-action danger"
                    onClick={() => {
                      setOpenMenuId(null);
                      void onDeleteStorage(storage);
                    }}
                  >
                    Delete
                  </button>
                </ListItemActionMenu>
              </div>
            ))}
          </div>
          <div className="bucket-panel-footer">
            <Link to="/profile" className="bucket-profile-link" title="Profile">
              <span className="bucket-profile-label">Profile</span>
              <span className="bucket-profile-collapsed">P</span>
            </Link>
          </div>
        </div>

        <div className="file-panel">
          {!selectedStorage ? (
            <div className="empty-state">
              <div>
                <strong>Select a storage</strong>
                <span>Choose a storage to browse objects.</span>
              </div>
            </div>
          ) : (
            <>
              <div className="file-toolbar">
                <div className="file-toolbar-main">
                  <h3>Object Storage Browser</h3>
                  <p className="storage-meta-line" title={selectedStorage.endpoint || undefined}>
                    <span>{selectedStorage.bucketName || '-'}</span>
                    <span className="meta-sep">·</span>
                    <span>{selectedStorage.storageType || 'ObjectStorage'}</span>
                    <span className="meta-sep">·</span>
                    <span className="meta-endpoint">{selectedStorage.endpoint || '-'}</span>
                    {selectedStorage.region ? (
                      <>
                        <span className="meta-sep">·</span>
                        <span>{selectedStorage.region}</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>
              {renderBreadcrumbs()}
              <div className="file-section">
                {loadingFiles ? <p className="muted">Loading…</p> : null}
                {!loadingFiles ? (
                  <>
                    <ObjectFileTable
                      bucketId={selectedId!}
                      items={items}
                      onOpenFolder={(relative) => setPrefix(relative)}
                      onDownload={(key) => void onDownload(key)}
                      onCopyLink={(item) => void onCopyLink(item)}
                      onCopyDownloadCli={(item) => void onCopyDownloadCli(item)}
                      onMove={(key, isPrefix) => void onMove(key, isPrefix)}
                      onDropMove={(sourceKey, folder) => void onDropMove(sourceKey, folder)}
                      onSetPublic={(key, isPrefix) => void onSetPublic(key, isPrefix)}
                      onSetPrivate={(key, isPrefix) => void onSetPrivate(key, isPrefix)}
                      onDelete={(key, isPrefix) => void onDeleteObject(key, isPrefix)}
                      onItemAccessChange={updateItemAccess}
                    />
                    {nextCursor ? (
                      <div className="file-list-footer">
                        <button
                          type="button"
                          className="action-btn"
                          disabled={loadingMore}
                          onClick={() => void onLoadMore()}
                        >
                          {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <StorageFormModal
        open={modalStorage !== null}
        storage={modalStorage === 'new' ? null : modalStorage}
        onClose={() => setModalStorage(null)}
        onSaved={() => {
          listingCache.invalidateAll();
          void loadStorages();
        }}
      />

      <UploadModal
        open={uploadOpen && !!selectedId}
        config={selectedId ? { mode: 'storage', bucketId: selectedId, relativePath: prefix } : null}
        storages={storages}
        onClose={() => setUploadOpen(false)}
        onComplete={() => {
          listingCache.invalidate((key) => key === listingKey(selectedId!, prefix));
          void loadFiles(true);
        }}
      />

      <MoveObjectModal
        open={moveTarget !== null}
        title={moveTarget?.isPrefix ? 'Move folder' : 'Move file'}
        initialPath={moveTarget?.initialPath ?? ''}
        onClose={() => setMoveTarget(null)}
        onConfirm={confirmMove}
      />
    </div>
  );
}
