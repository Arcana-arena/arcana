import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // THE RATE LIMITER MUST SEE THE REAL CALLER, and this is the line that decides
  // whether it does.
  //
  // The limiter keys on `req.ip`. Express only derives that from
  // `X-Forwarded-For` when it has been told which hops to trust; untold, it
  // returns the socket address. So the moment a reverse proxy is put in front,
  // every request in the world arrives from 127.0.0.1 and the whole internet
  // shares ONE bucket — not "rate limiting off", but a single global limit any
  // one caller can exhaust for everybody else. That is the day rate limiting
  // matters most.
  //
  // 'loopback' and NOT true. `trust proxy: true` trusts the leftmost address in
  // a header the CLIENT controls, which hands every caller the ability to pick
  // their own bucket — the same hole wearing the opposite mask. Trusting only
  // 127.0.0.1/::1 means Express walks in from the right and stops at the first
  // address the local proxy did not vouch for, which is the real client.
  //
  // The other half lives in infra/nginx/arcana.conf:
  // `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` APPENDS the
  // real peer to whatever the caller sent, so a forged header pushes the
  // attacker's own value to the left where it is ignored.
  app.set('trust proxy', 'loopback');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  const port = process.env.PORT ?? 3003;
  // Bind to loopback only. This is the first of the two layers protecting the
  // machine tier: even a leaked X-Internal-Key is useless from off-box, and a
  // service that is never exposed cannot be reached by a firewall mistake.
  await app.listen(port, '127.0.0.1');
  console.log(`arca-service listening on :${port}`);
}
void bootstrap();
