// Docker Hub API setup: create only the explicitly configured public repository.
// Existing private repositories are never made public by this helper.
export async function ensureDockerRepository({ image, username, token }, request = fetch) {
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(image ?? '')) throw Error('Invalid Docker Hub repository');
  if (!username || !token) throw Error('Missing Docker Hub credentials');
  const [namespace, name] = image.split('/');
  const auth = await request('https://hub.docker.com/v2/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, secret: token }),
  });
  if (!auth.ok) throw Error(`Docker Hub API authentication failed: ${auth.status}`);
  const { access_token } = await auth.json();
  if (!access_token) throw Error('Docker Hub did not return an access token');
  const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
  const url = `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${name}`;
  let response = await request(url, { headers });
  if (response.status === 404) {
    response = await request(`https://hub.docker.com/v2/namespaces/${namespace}/repositories`, {
      method: 'POST', headers,
      body: JSON.stringify({ namespace, name, registry: 'docker.io', is_private: false,
        description: 'Tracery Graph community hub: agent activity graphs, live tracing and self-hosted storage.',
        full_description: 'Source and documentation: https://github.com/Atriarch-Systems/tracery-graph\n\nOriginal Tracery Graph code is Apache-2.0. Third-party licenses apply. The image includes runtime notices. Matching Alpine sources for each version are published in this repository as the <version>-sources tag (and <version>-sources-amd64/-arm64) and attached to the GitHub release; /usr/share/tracery/SOURCES.txt in the image gives the exact locations, checksum and a written offer. Release evidence: https://github.com/Atriarch-Systems/tracery-graph/releases\n\nImages support linux/amd64 and linux/arm64. Version and latest tags select the native platform; explicit -amd64 and -arm64 tags are also available. See the source README for authentication and persistent storage setup.' }),
    });
  }
  if (!response.ok) throw Error(`Cannot access/create Docker Hub repository: ${response.status}; check namespace permissions`);
  const repo = await response.json();
  if (repo.is_private !== false) throw Error('Target repository is private; refusing to change its visibility');
  if (repo.permissions?.write !== true) throw Error('Docker Hub account lacks repository write permission');
  const publicResponse = await request(url);
  if (!publicResponse.ok || (await publicResponse.json()).is_private !== false) throw Error('Repository is not anonymously accessible');
}
