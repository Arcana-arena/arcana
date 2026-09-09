import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArcanaAuthModule } from '@arcana/auth';
import { HealthController } from './health.controller';
import { PaymentsModule } from './payments/payments.module';
import { EntitlementsModule } from './entitlements/entitlements.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ArcanaAuthModule.forRoot('arca-service'),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false, // schema is managed by golang-migrate, never sync
      }),
    }),
    PaymentsModule,
    EntitlementsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
