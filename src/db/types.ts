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
