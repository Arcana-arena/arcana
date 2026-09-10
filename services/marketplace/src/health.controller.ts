import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Liveness and readiness are different questions, and this service only ever
 * answered the easy one.
 *
 * `/healthz` returned `{status:'ok'}` from three string constants. It proved
 * the process was up and the HTTP stack was routing — which is genuinely
 * useful, and is what a restart policy should watch — but it says nothing
 * about whether the service can do its job. A service whose database is gone
 * answers `/healthz` cheerfully and fails every request.
 *
 * That is the shape of failure this codebase keeps writing down as the worst
 * one: healthy and wrong.
 *
 * So the two are separated rather than merged:
 *
 *   /healthz   LIVENESS.  Is this process running? Constants, no I/O, never
 *              fails while the process can answer. Anything watching this to
 *              decide whether to RESTART must not be told to restart because a
 *              dependency blinked — that turns one failing dependency into a
 *              restart loop across every service that touches it.
 *
 *   /readyz    READINESS. Can it serve? Touches the dependencies it cannot
 *              work without and returns 503 with the reason when it cannot.
 *
 * Merging them is the common mistake and it is not a small one: a liveness
 * probe that checks the database restarts a perfectly good process because
 * something else broke.
 */
@Controller()
export class HealthController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Liveness: no I/O, cannot fail while the process answers. */
  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'marketplace' };
  }

  /**
   * Readiness: can this service actually serve a request?
   *
   * Reports every dependency it checked and what each said, rather than a bare
   * pass/fail. "Not ready" is only actionable if it names which thing is not
   * ready, and a boolean sends whoever is paged to look at all of them.
   */
  @Get('readyz')
  async readyz() {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    const started = Date.now();
    try {
      // SELECT 1 rather than a table read: this asks whether the connection
      // works, not whether any particular migration has run. A readiness probe
      // that depends on schema details fails for reasons that are not about
      // readiness.
      await this.db.query('SELECT 1');
      checks.database = { ok: true, detail: `responded in ${Date.now() - started}ms` };
    } catch (e) {
      checks.database = { ok: false, detail: String((e as Error).message).slice(0, 200) };
    }

    const ready = Object.values(checks).every((c) => c.ok);
    const body = { status: ready ? 'ready' : 'not_ready', service: 'marketplace', checks };
    if (!ready) {
      // 503, so a load balancer stops sending traffic. The body still carries
      // the detail, because a probe that returns a bare status code makes
      // somebody log into the box to find out what it meant.
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
