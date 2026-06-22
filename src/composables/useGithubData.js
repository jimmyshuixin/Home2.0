import { computed, onBeforeUnmount, onMounted, reactive } from 'vue';
import { fallbackRepos, siteConfig } from '../data/site';

const scheduleIdleTask = (callback, delay = 1400) => {
  if (typeof window === 'undefined') return () => {};

  let idleId;
  const timeoutId = window.setTimeout(() => {
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(() => {
        void callback();
      }, { timeout: 4000 });
      return;
    }

    void callback();
  }, delay);

  return () => {
    window.clearTimeout(timeoutId);
    if (idleId) window.cancelIdleCallback?.(idleId);
  };
};

export function useGithubData() {
  const github = reactive({
    stats: { contributions: 0, repos: 0, stars: 0, forks: 0 },
    repos: [],
    pinnedRepos: [],
    isLoading: true,
    error: '',
  });

  const workerUrl = siteConfig.githubApiUrl;

  const getGithubData = async (endpoint, params = {}) => {
    const url = new URL(workerUrl);
    url.searchParams.set('endpoint', endpoint);
    url.searchParams.set('username', siteConfig.githubUser);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error('GitHub data unavailable');
      return response.json();
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const load = async () => {
    github.isLoading = true;
    github.error = '';
    try {
      const [statsResult, reposResult, pinnedResult] = await Promise.allSettled([
        getGithubData('stats'),
        getGithubData('repos', { page: 1, per_page: 30 }),
        getGithubData('pinned'),
      ]);

      if (statsResult.status === 'fulfilled') {
        github.stats.repos = statsResult.value.publicRepos || 0;
        github.stats.contributions = statsResult.value.contributions || 0;
      }
      if (reposResult.status === 'fulfilled') {
        github.repos = reposResult.value || [];
        github.stats.stars = github.repos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
        github.stats.forks = github.repos.reduce((sum, repo) => sum + (repo.forks_count || 0), 0);
      }
      if (pinnedResult.status === 'fulfilled') github.pinnedRepos = pinnedResult.value || [];
    } catch (error) {
      github.error = '暂时无法连接 GitHub，先展示本地精选。';
    } finally {
      github.isLoading = false;
    }
  };

  const featuredRepos = computed(() => {
    const pinned = github.pinnedRepos.map((repo) => ({
      name: repo.repo || repo.name,
      description: repo.description || '暂无描述',
      language: repo.language || 'Text',
      stars: repo.stars || 0,
      link: repo.link || siteConfig.githubProfile,
    }));
    const recent = github.repos
      .slice()
      .sort((a, b) => new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0))
      .slice(0, 3)
      .map((repo) => ({
        name: repo.name,
        description: repo.description || '暂无描述',
        language: repo.language || 'Text',
        stars: repo.stargazers_count || 0,
        link: repo.html_url || siteConfig.githubProfile,
      }));
    return [...pinned, ...recent].slice(0, 4).length ? [...pinned, ...recent].slice(0, 4) : fallbackRepos;
  });

  let cancelInitialLoad;
  onMounted(() => {
    cancelInitialLoad = scheduleIdleTask(load);
  });

  onBeforeUnmount(() => {
    cancelInitialLoad?.();
  });

  return { github, featuredRepos, reloadGithub: load };
}
