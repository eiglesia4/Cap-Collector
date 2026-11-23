#!/usr/bin/env node
/**
 * CapCollector CDK entry point.
 *
 *   npm run synth -w @capcollector/infra        # CAP_INSTALLATION / CAP_STAGE; config from CAP_CONFIG_DIR or config/
 *   npm run deploy -w @capcollector/infra       # the owner only, never an agent
 */
import { buildApp } from '../lib/app.js';

buildApp().app.synth();
