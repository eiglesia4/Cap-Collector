#!/usr/bin/env node
/**
 * CapCollector CDK entry point.
 *
 *   npm run synth -w @capcollector/infra                      # naeva/dev by default
 *   npx cdk deploy --all --context installation=naeva --context stage=dev   # Edu only, never an agent
 */
import { buildApp } from '../lib/app.js';

buildApp().app.synth();
