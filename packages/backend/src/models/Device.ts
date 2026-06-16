import mongoose, { Schema, Document } from 'mongoose';
import type { DeviceType } from '@syra/shared-types';

export interface IDevice extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  deviceId: string;
  name: string;
  type: DeviceType;
  capabilities: string[];
  lastSeen: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DEVICE_TYPES: DeviceType[] = ['web', 'mobile', 'desktop', 'speaker'];

const DeviceSchema = new Schema<IDevice>(
  {
    oxyUserId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: DEVICE_TYPES, required: true },
    capabilities: { type: [String], default: [] },
    lastSeen: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/** One row per (user, device) pair — re-registering updates rather than duplicates. */
DeviceSchema.index({ oxyUserId: 1, deviceId: 1 }, { unique: true });

export const DeviceModel: mongoose.Model<IDevice> =
  (mongoose.models.Device as mongoose.Model<IDevice>) ??
  mongoose.model<IDevice>('Device', DeviceSchema);
