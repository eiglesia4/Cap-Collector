// App Store readiness of the iOS project (CAP-56; ADR-001; CONVENTIONS: bundle com.naevatec.collectors, name
// CapCollector): Info.plist keys and usage strings, the privacy manifest, the single-size icon and the light/dark
// launch image, and the version in project.pbxproj. Plists are parsed as XML (no plist dependency); PNG sizes and
// colour types are read from the IHDR chunk.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const IOS = join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App');
const APP = join(IOS, 'App');
const ASSETS = join(APP, 'Assets.xcassets');

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function value(el: Element): PlistValue {
  switch (el.tagName) {
    case 'string':
      return el.textContent ?? '';
    case 'integer':
    case 'real':
      return Number(el.textContent);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array':
      return [...el.children].map(value);
    case 'dict': {
      const out: Record<string, PlistValue> = {};
      const children = [...el.children];
      for (let i = 0; i < children.length; i += 2) {
        const key = children[i];
        const val = children[i + 1];
        if (key?.tagName !== 'key' || !val) throw new Error('malformed dict');
        out[key.textContent ?? ''] = value(val);
      }
      return out;
    }
    default:
      throw new Error(`unsupported plist element <${el.tagName}>`);
  }
}

function plist(path: string): Record<string, PlistValue> {
  // DOCTYPE and comments are fine for the XML parser; only the root <dict> matters.
  const doc = new DOMParser().parseFromString(readFileSync(path, 'utf8'), 'application/xml');
  const root = doc.querySelector('plist > dict');
  if (!root) throw new Error(`${path}: no <plist><dict>`);
  return value(root) as Record<string, PlistValue>;
}

function png(path: string): { width: number; height: number; colourType: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(bytes.toString('latin1', 12, 16)).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25] ?? -1 };
}

interface CatalogImage {
  filename?: string;
  idiom?: string;
  platform?: string;
  size?: string;
  scale?: string;
  appearances?: { appearance: string; value: string }[];
}

function catalog(set: string): CatalogImage[] {
  return (JSON.parse(readFileSync(join(ASSETS, set, 'Contents.json'), 'utf8')) as { images: CatalogImage[] }).images;
}

describe('iOS release readiness', () => {
  it('[T-app-092] Info.plist: display name, export compliance, full screen, portrait-only iPhone, usage strings kept', () => {
    const info = plist(join(APP, 'Info.plist'));
    expect(info.CFBundleDisplayName).toBe('CapCollector');
    expect(info.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(info.UIRequiresFullScreen).toBe(true);
    expect(info.LSRequiresIPhoneOS).toBe(true);
    expect(info.UISupportedInterfaceOrientations).toEqual(['UIInterfaceOrientationPortrait']);
    expect(info.CFBundleShortVersionString).toBe('$(MARKETING_VERSION)');
    expect(info.CFBundleVersion).toBe('$(CURRENT_PROJECT_VERSION)');
    // CAP-21 usage strings: present and meaningful.
    for (const key of [
      'NSCameraUsageDescription',
      'NSPhotoLibraryUsageDescription',
      'NSPhotoLibraryAddUsageDescription',
      'NSLocationWhenInUseUsageDescription',
    ]) {
      expect(info[key], key).toMatch(/^CapCollector .{20,}/);
    }
    // HTTPS only (README § Network): no ATS exception.
    expect(info).not.toHaveProperty('NSAppTransportSecurity');

    // Version for the V2 build (README § Versions): marketing 0.5.0, build 1, in Debug and Release.
    const pbx = readFileSync(join(IOS, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx.match(/MARKETING_VERSION = ([^;]+);/g)).toEqual([
      'MARKETING_VERSION = 0.5.0;',
      'MARKETING_VERSION = 0.5.0;',
    ]);
    expect(pbx.match(/CURRENT_PROJECT_VERSION = ([^;]+);/g)).toEqual([
      'CURRENT_PROJECT_VERSION = 1;',
      'CURRENT_PROJECT_VERSION = 1;',
    ]);
    expect(pbx).toMatch(/PRODUCT_BUNDLE_IDENTIFIER = com\.naevatec\.collectors;/);
  });

  it('[T-app-093] the privacy manifest parses, declares no tracking, the collected data and the required-reason APIs, and ships in the bundle', () => {
    const manifest = plist(join(APP, 'PrivacyInfo.xcprivacy'));
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
    const collected = manifest.NSPrivacyCollectedDataTypes as Record<string, PlistValue>[];
    expect(collected.map((d) => d.NSPrivacyCollectedDataType)).toEqual([
      'NSPrivacyCollectedDataTypePhotosorVideos',
      'NSPrivacyCollectedDataTypeUserID',
      'NSPrivacyCollectedDataTypeCoarseLocation',
    ]);
    for (const d of collected) {
      expect(d.NSPrivacyCollectedDataTypeLinked).toBe(true);
      expect(d.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(d.NSPrivacyCollectedDataTypePurposes).toEqual(['NSPrivacyCollectedDataTypePurposeAppFunctionality']);
    }
    const apis = manifest.NSPrivacyAccessedAPITypes as Record<string, PlistValue>[];
    expect(
      Object.fromEntries(apis.map((a) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons])),
    ).toEqual({
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
    });
    // Referenced by the App target's Resources build phase, so it is copied into the .app.
    const pbx = readFileSync(join(IOS, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).toMatch(/PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile;/);
    expect(pbx).toMatch(/\/\* PrivacyInfo\.xcprivacy in Resources \*\/,\n\t\t\t\);/);
  });

  it('[T-app-094] the icon catalog has one opaque 1024 entry (the brand copper cap); the launch image has light and dark 2732² variants with the mark', () => {
    const icons = catalog('AppIcon.appiconset');
    expect(icons).toEqual([{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }]);
    // App Store Connect rejects an icon with alpha: colour type 2 = RGB.
    expect(png(join(ASSETS, 'AppIcon.appiconset', 'AppIcon-1024.png'))).toEqual({
      width: 1024,
      height: 1024,
      colourType: 2,
    });
    const design = join(IOS, '..', '..', 'design');
    const brand = join(IOS, '..', '..', '..', 'doc', 'spec', 'design', 'brand');
    const icon = readFileSync(join(design, 'icon.svg'), 'utf8');
    expect(icon).not.toMatch(/<text/);
    // CAP-74: the icon is the architect's copper cap on ink, verbatim; the old ring-and-dot drawing is gone.
    expect(icon).toBe(readFileSync(join(brand, 'icon.svg'), 'utf8'));
    expect(readFileSync(join(design, 'splash.svg'), 'utf8')).toMatch(
      /fill="#FAFAF7"\/><g transform=[^>]*>.*fill="#1B1A17"\/><\/g>/s,
    );
    expect(readFileSync(join(design, 'splash-dark.svg'), 'utf8')).toMatch(
      /fill="#1B1A17"\/><g transform=[^>]*>.*fill="#FAFAF7"\/><\/g>/s,
    );

    const splash = catalog('Splash.imageset');
    const dark = (i: CatalogImage) => i.appearances?.some((a) => a.appearance === 'luminosity' && a.value === 'dark');
    for (const scale of ['1x', '2x', '3x']) {
      const atScale = splash.filter((i) => i.scale === scale);
      expect(
        atScale.filter((i) => !dark(i)),
        `light ${scale}`,
      ).toHaveLength(1);
      expect(
        atScale.filter((i) => dark(i)),
        `dark ${scale}`,
      ).toHaveLength(1);
    }
    for (const image of splash) {
      expect(image.idiom).toBe('universal');
      const file = png(join(ASSETS, 'Splash.imageset', image.filename ?? ''));
      expect([file.width, file.height]).toEqual([2732, 2732]);
      expect(image.filename?.includes('dark') ?? false).toBe(dark(image) ?? false);
    }
    // The launch storyboard shows that image.
    expect(readFileSync(join(APP, 'Base.lproj', 'LaunchScreen.storyboard'), 'utf8')).toMatch(/image="Splash"/);
  });

  it('[T-app-184] Xcode names: target, product, module and shared scheme are CapCollector; the paths Capacitor hardcodes stay App', async () => {
    const { default: config } = await import('../capacitor.config');
    expect(config.ios?.scheme).toBe('CapCollector');
    expect(config.appId).toBe('com.naevatec.collectors');

    const pbx = readFileSync(join(IOS, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    // One native target, named CapCollector, building CapCollector.app; no target called App any more.
    expect(pbx).toMatch(/isa = PBXNativeTarget;[\s\S]*?name = CapCollector;[\s\S]*?productName = CapCollector;/);
    expect(pbx).not.toMatch(/^\t+name = App;$/m);
    expect(pbx).toContain('path = CapCollector.app;');
    expect(pbx.match(/PRODUCT_NAME = CapCollector;/g)).toHaveLength(2);
    // Unchanged: bundle id, entitlements, Info.plist and the App/ group.
    expect(pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.naevatec\.collectors;/g)).toHaveLength(2);
    expect(pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)).toHaveLength(2);
    expect(pbx.match(/INFOPLIST_FILE = App\/Info\.plist;/g)).toHaveLength(2);
    expect(pbx).toContain('path = App;');

    const scheme = readFileSync(
      join(IOS, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'CapCollector.xcscheme'),
      'utf8',
    );
    const doc = new DOMParser().parseFromString(scheme, 'application/xml');
    const refs = [...doc.querySelectorAll('BuildableReference')];
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(ref.getAttribute('BlueprintName')).toBe('CapCollector');
      expect(ref.getAttribute('BuildableName')).toBe('CapCollector.app');
      expect(ref.getAttribute('ReferencedContainer')).toBe('container:App.xcodeproj');
      expect(pbx).toContain(`${ref.getAttribute('BlueprintIdentifier') ?? '?'} /* CapCollector */ = {`);
    }
    expect(doc.querySelector('LaunchAction')?.getAttribute('buildConfiguration')).toBe('Debug');
    expect(doc.querySelector('ArchiveAction')?.getAttribute('buildConfiguration')).toBe('Release');

    // Home-screen name and bundle name; the storyboard's view controller lives in the CapCollector module.
    const info = plist(join(APP, 'Info.plist'));
    expect(info.CFBundleDisplayName).toBe('CapCollector');
    expect(info.CFBundleName).toBe('$(PRODUCT_NAME)');
    expect(readFileSync(join(APP, 'Base.lproj', 'Main.storyboard'), 'utf8')).toContain('customModule="CapCollector"');
  });

  it('[T-app-205] no Apple Team ID in the tracked project: the target signs from CapCollector.xcconfig → gitignored Local.xcconfig', () => {
    const pbx = readFileSync(join(IOS, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).not.toMatch(/DEVELOPMENT_TEAM\s*=/);
    // The target's Debug and Release are based on CapCollector.xcconfig (the project-level Debug keeps debug.xcconfig).
    const ref =
      /(\w{24}) \/\* CapCollector\.xcconfig \*\/ = \{isa = PBXFileReference;[^}]*path = CapCollector\.xcconfig;/.exec(
        pbx,
      )?.[1];
    expect(ref).toBeDefined();
    for (const name of ['Debug', 'Release']) {
      const config = new RegExp(
        `/\\* ${name} \\*/ = \\{\\s*isa = XCBuildConfiguration;\\s*baseConfigurationReference = ${ref ?? '?'} [^]*?PRODUCT_NAME = CapCollector;`,
      );
      expect(pbx, name).toMatch(config);
    }
    const xcconfig = readFileSync(join(IOS, 'CapCollector.xcconfig'), 'utf8');
    expect(xcconfig).toMatch(/^#include\? "Local\.xcconfig"$/m);
    expect(xcconfig).not.toMatch(/DEVELOPMENT_TEAM/);
    expect(readFileSync(join(IOS, 'Local.xcconfig.example'), 'utf8')).toMatch(/^DEVELOPMENT_TEAM = <your team id>$/m);
    expect(readFileSync(join(IOS, '..', '.gitignore'), 'utf8')).toMatch(/^App\/Local\.xcconfig$/m);
  });
});
