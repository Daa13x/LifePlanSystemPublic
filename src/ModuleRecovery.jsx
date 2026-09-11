import React from 'react';
import { diagnosticRoute } from './navigation.js';

const buildId = (value) => /^[a-f0-9]{7,64}$/i.test(value || '') ? value : 'unknown';
const frontendAsset = new URL(import.meta.url).pathname.split('/').pop();
const frontendBuild = /^index-[\w-]+\.js$/.test(frontendAsset) ? frontendAsset : 'development';

export function moduleDiagnostic(code, route, previousRoute, backendBuild) {
  // Allowlisted metadata only: no exception text/stacks, raw URLs, session IDs,
  // DOM content, request bodies, filesystem paths or settings.
  return {
    code, correlationId: crypto.randomUUID(), timestamp: new Date().toISOString(),
    attemptedLocation: diagnosticRoute(route), previousLocation: diagnosticRoute(previousRoute),
    module: diagnosticRoute({ section: route?.section }), submodule: diagnosticRoute(route),
    frontendBuildId: frontendBuild, backendBuildId: buildId(backendBuild)
  };
}

export default class ModuleRecovery extends React.Component {
  state = { failed: false, diagnostic: null, copied: false };
  content = React.createRef();
  unusableSince = Date.now();
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.fail('MODULE_RENDER_FAILED'); }
  componentDidMount() {
    if (this.props.route.section === 'unknown') { this.fail('UNKNOWN_ROUTE'); return; }
    this.timer = setInterval(() => this.checkContent(), 250);
    this.checkContent();
  }
  componentWillUnmount() { clearInterval(this.timer); }
  componentDidUpdate(previous) {
    if (this.state.diagnostic && previous.backendBuild !== this.props.backendBuild) {
      this.setState(({ diagnostic }) => ({ diagnostic: { ...diagnostic, backendBuildId: buildId(this.props.backendBuild) } }));
    }
  }
  checkContent() {
    if (this.state.failed) return;
    const node = this.content.current;
    const text = node?.innerText?.trim() || '';
    const usable = Boolean(text && !/^(loading|checking)(?:\s|…|\.)/i.test(text)
      && node.getBoundingClientRect().height > 0 && !node.querySelector('[data-module-pending="true"]'));
    if (usable) this.unusableSince = Date.now();
    else if (Date.now() - this.unusableSince >= (this.props.timeoutMs || 15000)) this.fail('MODULE_LOAD_TIMEOUT');
  }
  fail(code) {
    clearInterval(this.timer);
    this.setState({ failed: true, diagnostic: moduleDiagnostic(code, this.props.route, this.props.previousRoute, this.props.backendBuild) });
  }
  copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(this.state.diagnostic, null, 2)); this.setState({ copied: true }); }
    catch { this.setState({ copied: false }); this.report?.focus(); this.report?.select(); }
  };
  render() {
    if (!this.state.failed) return <div className="module-content" ref={this.content}>
      <React.Suspense fallback={<div data-module-pending="true" role="status">Loading module…</div>}>
        {this.props.children}
      </React.Suspense>
    </div>;
    const diagnostic = this.state.diagnostic;
    return <section className="panel module-recovery" role="alert" aria-label="Module recovery">
      <h1>{diagnostic?.code === 'UNKNOWN_ROUTE' ? 'Page not found' : 'This module could not be displayed'}</h1>
      <p>Your saved data has not been reset. Navigation remains available.</p>
      <p>{diagnostic?.attemptedLocation} · {diagnostic?.code || 'MODULE_RENDER_FAILED'}</p>
      <div className="module-recovery-actions">
        <button className="secondary" onClick={this.props.onRetry}>Retry</button>
        <button className="secondary" onClick={this.props.onBack}>Back</button>
        <button className="secondary" onClick={this.props.onHome}>Home / Chat</button>
        <button className="secondary" onClick={this.copy} disabled={!diagnostic}>Copy diagnostics</button>
      </div>
      <label>Safe diagnostic report<textarea ref={(node) => { this.report = node; }} readOnly value={diagnostic ? JSON.stringify(diagnostic, null, 2) : ''} /></label>
      <span role="status">{this.state.copied ? 'Diagnostics copied.' : 'If copying is unavailable, select the report above.'}</span>
    </section>;
  }
}
