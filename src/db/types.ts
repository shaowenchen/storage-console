export interface Bucket {
  id: string;
  name: string;
  storageType: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucketName: string;
  bucketPath: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface StorageFile {
  id: string;
  bucketId: string;
  userId: string;
  username: string;
  path: string;
  name: string;
  size: number;
  contentType: string | null;
  eTag: string | null;
  lastModified: number | null;
  storageClass: string | null;
  metadata: Record<string, unknown> | null;
  source: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
