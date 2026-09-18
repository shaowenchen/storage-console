import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  confirm,
  notify,
  notifyError,
  toast,
  updateToast,
} from '../../shared/components/AppNotice';
import { ListRailHeader } from '../../shared/components/ListRailHeader';
import { ListItemActionMenu } from '../../shared/components/ListItemActionMenu';
import { MoveObjectModal } from '../../shared/components/MoveObjectModal';
import { useRailCollapsed } from '../../shared/components/useRailCollapsed';
import { UploadModal } from '../../shared/components/UploadModal';
import { useListingCache } from '../../shared/hooks/useListingCache';
import { apiUrl } from '../../shared/api';
import { downloadAll } from '../../shared/download/batch';
import {
  downloadIntoDirectory,
  pickDirectory,
  readableFetchError,
  relativeDownloadSegments,
  supportsDirectoryPicker,
  type DirectoryDownloadEntry,
  type DirectoryHandleLike,
} from '../../shared/download/directory';
import { copyToClipboard, objectAbsoluteKey, objectRelativePath } from '../../shared/format';
import { requestErrorMessage } from '../../shared/requestError';
import { getDownloadKey, storageDownloadScriptUrl } from '../../shared/upload/api';
import { downloadRunCommand } from '../../shared/upload/helpers';
import {
  deleteStorage,
  deleteStorageObject,
  getDownloadLink,
  getDownloadLinks,
  getObjectAccess,
  listObjectKeys,
  listStorageFiles,
  listStorages,
  moveStorageObject,
  setObjectPrivate,
  setObjectPublic,
  testStorage,
} from './api';
import { ObjectFileTable } from './ObjectFileTable';
import { ObjectTextModal, type ObjectTextMode } from './ObjectTextModal';
import { StorageFormModal } from './StorageFormModal';
import type { Storage, StorageFileItem } from './types';
import {
  applyStorageLocation,
  parseStorageLocation,
  type StorageLocation,
} from './urlState';
import './storages.css';

const STORAGE_LIST_KEY = 'storageConsole.storageListCollapsed';
const LEGACY_STORAGE_LIST_KEY = 'studio.storageListCollapsed';
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
  const [listReady, setListReady] = useState(false);
  // The open storage and folder live in the URL, so a refresh (or a shared
  // link) reopens the same listing rather than the first bucket's root. The URL
  // is the single source of truth; navigate to change them.
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useMemo(() => parseStorageLocation(searchParams), [searchParams]);
  const { storageId: selectedId, prefix } = location;

  const navigateTo = useCallback(
    (next: StorageLocation) => {
      setSearchParams((prev) => applyStorageLocation(prev, next));
    },
    [setSearchParams],
  );

  const setPrefix = useCallback(
    (nextPrefix: string) => {
      navigateTo({ storageId: selectedId, prefix: nextPrefix });
    },
    [navigateTo, selectedId],
  );

  const selectStorage = useCallback(
    (nextId: string | null) => {
      navigateTo({ storageId: nextId, prefix: '' });
    },
    [navigateTo],
  );

  const [items, setItems] = useState<StorageFileItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filesPending, setFilesPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const { collapsed, toggleCollapsed } = useRailCollapsed(
    STORAGE_LIST_KEY,
    LEGACY_STORAGE_LIST_KEY,
  );
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [railMenuOpen, setRailMenuOpen] = useState(false);
  const [modalStorage, setModalStorage] = useState<Storage | null | 'new'>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{
    key: string;
    isPrefix: boolean;
    initialPath: string;
  } | null>(null);
  const [textEditor, setTextEditor] = useState<{ key: string; mode: ObjectTextMode } | null>(
    null,
  );

  const listingCache = useListingCache<{
    items: StorageFileItem[];
    nextCursor: string | null;
    prefix: string;
  }>();
  const aclHydrateGen = useRef(0);
  const listingScopeRef = useRef({ bucketId: '', prefix: '' });

  const selectedStorage = storages.find((s) => s.id === selectedId);

  const updateItemAccess = useCallback(
    (key: string, access: ObjectAccessPatch, scope?: { bucketId: string; prefix: string }) => {
      const active = listingScopeRef.current;
      if (scope && (scope.bucketId !== active.bucketId || scope.prefix !== active.prefix)) {
        return;
      }
      const bucketId = scope?.bucketId || active.bucketId;
      const listPrefix = scope?.prefix ?? active.prefix;
      if (!bucketId) return;

      setItems((prev) => {
        if (
          listingScopeRef.current.bucketId !== bucketId ||
          listingScopeRef.current.prefix !== listPrefix
        ) {
          return prev;
        }
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
        const cacheKey = listingKey(bucketId, listPrefix);
        const cached = listingCache.get(cacheKey);
        if (cached) {
          listingCache.set(cacheKey, { ...cached, items: next });
        }
        return next;
      });
    },
    [listingCache],
  );

  const hydrateObjectAcls = useCallback(
    async (bucketId: string, listPrefix: string, listed: StorageFileItem[]) => {
      const pending = listed.filter((item) => item.type === 'file' && !item.aclResolved);
      if (!pending.length) return;
      const scope = { bucketId, prefix: listPrefix };
      const gen = ++aclHydrateGen.current;
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          if (aclHydrateGen.current !== gen) return;
          const item = pending[cursor++];
          try {
            const access = await getObjectAccess(bucketId, item.key);
            if (aclHydrateGen.current !== gen) return;
            updateItemAccess(item.key, { ...access, aclResolved: true }, scope);
          } catch {
            if (aclHydrateGen.current !== gen) return;
            // Do not pretend the object is private when the probe failed.
            updateItemAccess(
              item.key,
              { isPublic: false, aclSupported: false, aclResolved: true },
              scope,
            );
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

  // Stable: only fetches the list. Which entry is selected is reconciled
  // separately below, so this does not re-run (and re-fetch) on every
  // selection change.
  const loadStorages = useCallback(async () => {
    try {
      const data = await listStorages();
      setStorages(data);
    } catch (err) {
      notifyError(requestErrorMessage(err, 'Failed to load storages'), 'Failed to load storages');
    } finally {
      setListReady(true);
    }
  }, []);

  const loadFiles = useCallback(
    async (force = false) => {
      if (!selectedId) return;
      listingScopeRef.current = { bucketId: selectedId, prefix };
      const cacheKey = listingKey(selectedId, prefix);
      if (!force) {
        const cached = listingCache.get(cacheKey);
        if (cached) {
          setFilesPending(false);
          setItems(cached.items);
          setNextCursor(cached.nextCursor);
          void hydrateObjectAcls(selectedId, prefix, cached.items);
          return;
        }
        // Silent swap: clear stale rows without a Loading… placeholder.
        setItems([]);
        setNextCursor(null);
        setFilesPending(true);
      }
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
        if (
          listingScopeRef.current.bucketId !== selectedId ||
          listingScopeRef.current.prefix !== prefix
        ) {
          return;
        }
        setItems(data.items);
        setNextCursor(data.nextCursor);
        setFilesPending(false);
        void hydrateObjectAcls(selectedId, prefix, data.items);
      } catch (err) {
        if (
          listingScopeRef.current.bucketId !== selectedId ||
          listingScopeRef.current.prefix !== prefix
        ) {
          return;
        }
        setItems([]);
        setNextCursor(null);
        setFilesPending(false);
        const message = requestErrorMessage(err, 'Failed to load files');
        if (message.includes('failed recently')) return;
        notifyError(message, 'Failed to load storage objects');
      }
    },
    [selectedId, prefix, listingCache, hydrateObjectAcls],
  );

  useEffect(() => {
    void loadStorages();
  }, [loadStorages]);

  // Guards the first listing: a URL can name a storage that no longer exists
  // (deleted, or a link from another deployment), and requesting its files
  // would only 404 and flash an error before the reconcile below fixes it.
  const selectionIsKnown = !selectedId || storages.some((s) => s.id === selectedId);

  useEffect(() => {
    if (selectedId && selectionIsKnown) void loadFiles();
  }, [selectedId, prefix, loadFiles, selectionIsKnown]);

  /**
   * Reconcile the URL against the storages that actually exist. An empty URL
   * (a fresh visit) selects the first storage; a URL naming a storage that has
   * since been deleted falls back the same way. The replacement is done with
   * `replace`, so it does not leave a dead entry in history.
   */
  useEffect(() => {
    if (!listReady) return;
    if (selectedId && storages.some((s) => s.id === selectedId)) return;
    const firstId = storages[0]?.id ?? null;
    if (firstId === selectedId) return;
    setSearchParams((prev) => applyStorageLocation(prev, { storageId: firstId, prefix: '' }), {
      replace: true,
    });
    setItems([]);
    setNextCursor(null);
  }, [listReady, storages, selectedId, setSearchParams]);

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
      void hydrateObjectAcls(selectedId, prefix, newItems);
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
        // Leaves the URL invalid; the reconcile effect picks the next storage.
        selectStorage(null);
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

  /**
   * Downloads every object under a folder.
   *
   * On browsers with the File System Access API the user picks a directory and
   * the objects are written into it, which preserves the folder structure and
   * gives real progress. Elsewhere every file is handed to the browser as its
   * own download, which flattens the tree — a per-file download cannot create
   * directories, so nested names collide and the browser renames them.
   */
  async function onDownloadFolder(key: string) {
    if (!selectedId) return;
    const bucketId = selectedId;

    // The picker needs transient user activation, so it is opened before the
    // first await: listing the folder first would spend the gesture and the
    // picker would be refused.
    let directory: DirectoryHandleLike | null = null;
    if (supportsDirectoryPicker()) {
      try {
        directory = await pickDirectory();
      } catch (err) {
        notifyError(readableFetchError(err));
        return;
      }
      // Dismissing the picker is a decision, not a failure.
      if (!directory) return;
    }

    let listing;
    try {
      listing = await listObjectKeys(bucketId, key, true);
    } catch (err) {
      notifyError(requestErrorMessage(err, 'Failed to list folder contents'));
      return;
    }
    if (!listing.keys.length) {
      toast('Folder is empty', 'error');
      return;
    }
    if (listing.truncated) {
      toast(
        `Folder has more than ${listing.maxObjects} objects; downloading the first ${listing.maxObjects}`,
        'error',
      );
    }

    if (!directory) {
      const urls = listing.keys.map((objectKey) => {
        const params = new URLSearchParams({ key: objectKey });
        return apiUrl(`/storages/${encodeURIComponent(bucketId)}/download-object?${params}`);
      });
      const started = toast(`Downloading ${urls.length} files…`);
      const result = await downloadAll(urls);
      updateToast(started, `Started ${result.started} downloads`);
      return;
    }

    let links;
    try {
      links = await getDownloadLinks(bucketId, listing.keys);
    } catch (err) {
      notifyError(requestErrorMessage(err, 'Failed to create download links'));
      return;
    }

    const entries: DirectoryDownloadEntry[] = links.links.map((link) => ({
      segments: relativeDownloadSegments(link.key, key),
      url: link.url,
    }));

    const started = toast(`Downloading ${entries.length} files…`);
    const result = await downloadIntoDirectory(directory, entries, {
      onProgress: (written, total) => {
        if (written === total || (written > 0 && written % 5 === 0)) {
          updateToast(started, `Downloading ${written}/${total}…`);
        }
      },
    });

    if (result.failed.length) {
      updateToast(
        started,
        `Wrote ${result.written}/${entries.length} files; ${result.failed.length} failed`,
        'error',
      );
      // One message for the first failure: a bucket refusing cross-origin
      // reads fails every file the same way, and the reason is the actionable
      // part — it is fixed on the bucket, not here.
      notifyError(result.failed[0]!.reason, 'Some files could not be downloaded');
    } else {
      updateToast(started, `Downloaded ${result.written} files`);
    }
  }

  /**
   * Opens the object in a new tab. This navigates straight to the redirect
   * route, so there is no await before the tab opens (a popup blocker would eat
   * a deferred call) and the signed URL never passes through JS.
   */
  function onOpen(key: string) {
    if (!selectedId) return;
    const params = new URLSearchParams({ key, disposition: 'inline' });
    const url = apiUrl(`/storages/${encodeURIComponent(selectedId)}/download-object?${params}`);
    // A synthetic anchor, not window.open: it always opens a tab, never a
    // popup window, and `noopener` keeps the redirect target out of `window.opener`.
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  }

  async function onCopyLink(item: StorageFileItem) {
    if (!selectedId) return;
    if (item.isPublic && item.publicUrl) {
      if (await copyToClipboard(item.publicUrl)) {
        toast('Public path copied');
        return;
      }
      notify(`Copy failed. Public path:\n${item.publicUrl}`);
      return;
    }
    try {
      const { url, expiresInSeconds } = await getDownloadLink(selectedId, item.key);
      const minutes = Math.max(1, Math.round((expiresInSeconds || 900) / 60));
      if (await copyToClipboard(url)) {
        toast(`Download link copied · valid ~${minutes} min`);
        return;
      }
      notify(`Copy failed. Direct download link (valid ~${minutes} min):\n${url}`);
    } catch {
      notifyError('Failed to create download link');
    }
  }

  /** Copies the open folder's full object path, rooted at the bucket path. */
  async function onCopyPath(path: string) {
    if (await copyToClipboard(path)) {
      toast('Path copied');
      return;
    }
    notify(`Copy failed. Path:\n${path}`);
  }

  async function onCopyDownloadCli(item: StorageFileItem) {
    if (!selectedId) return;
    try {
      const key = await getDownloadKey();
      const endpoint = storageDownloadScriptUrl(selectedId, item.key);
      const cmd = downloadRunCommand(endpoint, key);
      if (await copyToClipboard(cmd)) {
        toast('Download CLI command copied');
        return;
      }
      notify(`Copy failed. Select and copy manually:\n${cmd}`);
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
    const currentPath = displayParts.join('/');

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
        <button
          type="button"
          className="path-copy-btn"
          title="Copy this folder's path"
          aria-label="Copy current path"
          onClick={() => void onCopyPath(currentPath)}
        >
          ⧉
        </button>
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
            {listReady && !storages.length ? (
              <p className="muted">No storages configured.</p>
            ) : null}
            {storages.map((storage) => (
              <div
                key={storage.id}
                className={`bucket-item ${storage.id === selectedId ? 'active' : ''}`}
                onClick={() => {
                  if (selectedId === storage.id) return;
                  selectStorage(storage.id);
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
                <ObjectFileTable
                  bucketId={selectedId!}
                  items={items}
                  pending={filesPending}
                  onOpenFolder={(relative) => setPrefix(relative)}
                  onOpen={(key) => onOpen(key)}
                  onEdit={(key) => setTextEditor({ key, mode: 'edit' })}
                  onDownload={(key) => void onDownload(key)}
                  onDownloadFolder={(key) => void onDownloadFolder(key)}
                  onCopyLink={(item) => void onCopyLink(item)}
                  onCopyDownloadCli={(item) => void onCopyDownloadCli(item)}
                  onMove={(key, isPrefix) => void onMove(key, isPrefix)}
                  onDropMove={(sourceKey, folder) => void onDropMove(sourceKey, folder)}
                  onSetPublic={(key, isPrefix) => void onSetPublic(key, isPrefix)}
                  onSetPrivate={(key, isPrefix) => void onSetPrivate(key, isPrefix)}
                  onDelete={(key, isPrefix) => void onDeleteObject(key, isPrefix)}
                  onItemAccessChange={updateItemAccess}
                />
                {items.length ? (
                  <div className="file-list-footer">
                    <span className="muted">
                      Loaded {items.length} {items.length === 1 ? 'object' : 'objects'}
                      {nextCursor ? ' · more available' : ''}
                    </span>
                    {nextCursor ? (
                      <button
                        type="button"
                        className="action-btn"
                        disabled={loadingMore}
                        onClick={() => void onLoadMore()}
                      >
                        Load more
                      </button>
                    ) : null}
                  </div>
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

      {selectedId && textEditor ? (
        <ObjectTextModal
          open
          bucketId={selectedId}
          objectKey={textEditor.key}
          mode={textEditor.mode}
          onClose={() => setTextEditor(null)}
          onSaved={() => {
            listingCache.invalidate((key) => key === listingKey(selectedId, prefix));
            void loadFiles(true);
          }}
        />
      ) : null}
    </div>
  );
}
