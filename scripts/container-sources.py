#!/usr/bin/env python3
"""Archive corresponding Alpine sources, recipes and notices for the runtime.

Runs only in the isolated Docker source-collection stage, without credentials.
The installed APK database, not a hand-maintained package list, is authoritative.
Every upstream source must pass the exact recipe's abuild checksum verification.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile


def run(*args, cwd=None, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


root = Path('/source-bundle')
root.mkdir()
db = Path('/runtime-installed').read_text()
packages = []
for record in db.strip().split('\n\n'):
    fields = dict(line.split(':', 1) for line in record.splitlines() if ':' in line)
    if 'P' not in fields:
        continue
    package = {key: fields.get(field, '') for key, field in {
        'name': 'P', 'version': 'V', 'license': 'L', 'origin': 'o',
        'aportsCommit': 'c', 'architecture': 'A',
    }.items()}
    if not re.fullmatch(r'[a-z0-9][a-z0-9+._-]*', package['origin']):
        raise RuntimeError(f'Invalid source origin: {package}')
    if not re.fullmatch(r'[0-9a-f]{40}', package['aportsCommit']):
        raise RuntimeError(f'Missing exact source revision: {package}')
    packages.append(package)
if not packages:
    raise RuntimeError('Empty runtime inventory')

git = Path('/aports')
run('git', 'init', str(git))
run('git', 'remote', 'add', 'origin', 'https://github.com/alpinelinux/aports.git', cwd=git)
origins = sorted({(p['origin'], p['aportsCommit']) for p in packages})
run('git', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'fetch', '--depth=1',
    'origin', *sorted({commit for _, commit in origins}), cwd=git)
for origin, commit in origins:
    print(f'Collecting {origin} at {commit}', flush=True)
    directory = root / 'recipes' / origin
    directory.mkdir(parents=True)
    archive = Path('/recipe.tar')
    run('git', 'archive', '--format=tar', f'--output={archive}', commit, f'main/{origin}', cwd=git)
    with tarfile.open(archive) as tar:
        tar.extractall('/recipe', filter='data')
    shutil.copytree(Path('/recipe/main') / origin, directory, dirs_exist_ok=True)
    shutil.rmtree('/recipe')
    version = subprocess.check_output(
        ['sh', '-c', '. ./APKBUILD; printf "%s-r%s" "$pkgver" "$pkgrel"'],
        cwd=directory, text=True)
    if any(p['version'] != version for p in packages if (p['origin'], p['aportsCommit']) == (origin, commit)):
        raise RuntimeError(f'Recipe version mismatch for {origin}: {version}')
    dist = root / 'distfiles' / origin
    dist.mkdir(parents=True)
    env = {**os.environ, 'SRCDEST': str(dist)}
    if (directory / 'src').exists():
        raise RuntimeError(f'Recipe unexpectedly includes a src directory: {origin}')
    run('abuild', '-F', 'fetch', 'verify', cwd=directory, env=env)
    # abuild makes absolute convenience symlinks here. They are not source;
    # exclude them so the delivered archive is relocatable on another machine.
    if (directory / 'src').exists():
        shutil.rmtree(directory / 'src')
    (directory / 'APORTS_COMMIT').write_text(commit + '\n')

# Full source archives retain all notices, not just the filenames recognized here.
# Also expose common upstream license texts without requiring archive extraction.
notices = root / 'notices'
notices.mkdir()
for archive in sorted((root / 'distfiles').rglob('*')):
    if not archive.is_file() or not tarfile.is_tarfile(archive):
        continue
    with tarfile.open(archive) as tar:
        for member in tar:
            if not member.isfile() or member.size > 2_000_000:
                continue
            if not re.match(r'^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([._-].*)?$', Path(member.name).name, re.I):
                continue
            safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', member.name)
            destination = notices / archive.parent.name
            destination.mkdir(exist_ok=True)
            (destination / safe_name).write_bytes(tar.extractfile(member).read())

shutil.copy('/runtime-installed', root / 'installed.apk.txt')
(root / 'packages.json').write_text(json.dumps(packages, indent=2) + '\n')
(root / 'README.txt').write_text('''Corresponding sources for the Alpine components in this Tracery image.

packages.json records each installed binary package, version, declared license,
architecture, source origin and exact Alpine aports commit. recipes/ contains
that commit's APKBUILD, patches and configuration. distfiles/ contains the
upstream source archives verified by abuild against that recipe's checksums.
notices/ exposes common license texts; full archives retain all original notices.
No base-package source was modified by Tracery.

To rebuild a package, use an Alpine 3.24 environment of the recorded architecture
with alpine-sdk and the dependencies listed in its APKBUILD. Copy the recipe to
a writable directory, set SRCDEST to the corresponding distfiles/<origin>
directory, then run abuild -r as an unprivileged abuild user. See the Alpine
abuild documentation: https://wiki.alpinelinux.org/wiki/Abuild_and_Helpers
Toolchain/system dependencies are supplied by Alpine's v3.24 repositories.

This archive accompanies the binaries at /usr/share/tracery/sources.tar.gz in
the image and is also attached to the matching GitHub release. To extract it:
docker create --name tracery-sources IMAGE:VERSION
docker cp tracery-sources:/usr/share/tracery/sources.tar.gz .
docker rm tracery-sources

Tracery is Apache-2.0. These independent operating-system components retain
their own licenses; they are not relicensed by Tracery. Node's complete license
and bundled notices are at /usr/share/licenses/node/LICENSE in the image.
''')
hashes = []
for item in sorted(root.rglob('*')):
    if item.is_file():
        hashes.append(f'{hashlib.sha256(item.read_bytes()).hexdigest()}  {item.relative_to(root)}')
(root / 'SHA256SUMS').write_text('\n'.join(hashes) + '\n')
Path('/out').mkdir()
shutil.copy(root / 'packages.json', '/out/alpine-packages.json')
shutil.copy(root / 'README.txt', '/out/SOURCES.txt')
with tarfile.open('/out/sources.tar.gz', 'w:gz') as tar:
    tar.add(root, arcname='sources')
print(f'Collected verified sources for {len(packages)} packages / {len(origins)} origins', flush=True)
