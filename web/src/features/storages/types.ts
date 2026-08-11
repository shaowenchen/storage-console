export type Storage = {
  id: string;
  name: string;
  storageType: string;
  endpoint: string;
  region?: string;
  accessKey?: string;
  secretKeyMasked?: string;
  bucketName: string;
  bucketPath?: string;
  createdAt?: number;
  deletedAt?: number | null;
};

export type StorageFileItem = {
  type: 'folder' | 'file';
  id?: string;
  key: string;
  path: string;
  name: string;
  size?: number;
  username?: string;
  createdAt?: number;
  contentType?: string | null;
  source?: 's3' | 'studio';
  isPublic?: boolean;
  publicUrl?: string;
  relativePath?: string;
  bucketId?: string;
};

export type StorageFilesResponse = {
  items: StorageFileItem[];
  nextCursor?: string | null;
  prefix?: string;
};

export type StorageFormValues = {
  name: string;
  storageType: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucketName: string;
  bucketPath: string;
};

export type StorageTestResult = {
  ok: boolean;
  message?: string;
};
