import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('user_push_tokens')
@Unique(['userWallet', 'deviceToken'])
export class UserPushToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_wallet', type: 'varchar', length: 64 })
  userWallet: string;

  @Column({ name: 'device_token', type: 'text' })
  deviceToken: string;

  @Column({ type: 'varchar', length: 20 })
  platform: string; // fcm, web_push

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
