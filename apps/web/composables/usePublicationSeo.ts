import { site } from '~/lib/site'
import { albumImageIds, creationImageIds, sharingImage } from '~/lib/publication-metadata'
import type { Album, Creation } from '~/lib/models'

export function usePublicationSeo(getEntry: () => Creation | Album | undefined, kind: 'creation' | 'album') {
  const config = useRuntimeConfig(), origin = String(config.public.publicOrigin)
  const meta = computed(() => {
    const entry = getEntry()
    if (!entry) return undefined
    const creation = kind === 'creation' ? entry as Creation : undefined
    const title = creation?.seo?.title || entry.title
    const description = creation ? creation.seo?.description || creation.summary : (entry as Album).description
    const image = sharingImage(site.assets, creation ? creationImageIds(creation) : albumImageIds(entry as Album), origin)
    const url = `${origin}/${kind === 'creation' ? 'creations' : 'photography'}/${encodeURIComponent(entry.slug)}`
    return { title, description, image, url, publishedAt: entry.publishedAt }
  })
  useSeoMeta({ title: () => `${meta.value?.title || ''} · 虚宁`, description: () => meta.value?.description,
    ogTitle: () => meta.value?.title, ogDescription: () => meta.value?.description, ogType: 'article', ogLocale: 'zh_CN', ogSiteName: site.settings.siteTitle,
    ogUrl: () => meta.value?.url, ogImage: () => meta.value?.image.url, ogImageAlt: () => meta.value?.title, ogImageWidth: () => meta.value?.image.width, ogImageHeight: () => meta.value?.image.height, ogImageType: () => meta.value?.image.type,
    articlePublishedTime: () => meta.value?.publishedAt, twitterCard: 'summary_large_image', twitterTitle: () => meta.value?.title, twitterDescription: () => meta.value?.description, twitterImage: () => meta.value?.image.url, twitterImageAlt: () => meta.value?.title })
  useHead(() => ({ script: meta.value ? [{ key: 'publication-jsonld', type: 'application/ld+json', innerHTML: JSON.stringify({ '@context': 'https://schema.org', '@type': kind === 'creation' ? 'BlogPosting' : 'CollectionPage', '@id': `${meta.value.url}#publication`, url: meta.value.url, headline: meta.value.title, name: meta.value.title, description: meta.value.description, image: meta.value.image.url, datePublished: meta.value.publishedAt, inLanguage: 'zh-CN', author: { '@type': 'Person', name: '虚宁', url: `${origin}/about` }, mainEntityOfPage: meta.value.url }).replace(/</gu, '\\u003c') }] : [] }))
}
