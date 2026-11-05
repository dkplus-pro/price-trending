// 本文件:行情转发的内存 TTL 缓存(见 market.go)。
// 设计:以完整上游 URL 为 key,sync.RWMutex + map 存 {body, expireAt};命中不打上游。
// 条目数封顶(MarketCacheMaxEntries),写入时先清扫过期条目、仍满则淘汰最早过期条目
// (同一 TTL 下等价于最旧插入),保证长驻进程内存有界。
package service

import (
	"sync"
	"time"
)

// marketCacheEntry 单条缓存:上游原始响应体(只读共享)+ 过期时刻。
type marketCacheEntry struct {
	body     []byte
	expireAt time.Time
}

// marketCache 内存 TTL 缓存。
type marketCache struct {
	mu      sync.RWMutex
	entries map[string]marketCacheEntry
	max     int
}

// newMarketCache 构造缓存(max 为条目上限,须 > 0)。
func newMarketCache(max int) *marketCache {
	return &marketCache{entries: make(map[string]marketCacheEntry), max: max}
}

// get 命中且未过期才返回;过期条目懒删除(读锁判定,升级写锁删除时双检防并发误删)。
func (c *marketCache) get(key string) ([]byte, bool) {
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if time.Now().Before(entry.expireAt) {
		return entry.body, true
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[key]; ok && time.Now().After(entry.expireAt) {
		delete(c.entries, key)
	}
	return nil, false
}

// set 写入缓存;写入前顺带清扫过期条目(不只靠懒删除积压),容量满时淘汰最早过期条目。
func (c *marketCache) set(key string, body []byte, ttl time.Duration) {
	now := time.Now()
	expireAt := now.Add(ttl)

	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.entries {
		if now.After(e.expireAt) {
			delete(c.entries, k)
		}
	}
	if _, exists := c.entries[key]; !exists && len(c.entries) >= c.max {
		// 条目数封顶 O(max),遍历找最早过期条目开销可忽略。
		oldestKey, oldestAt := "", time.Time{}
		for k, e := range c.entries {
			if oldestKey == "" || e.expireAt.Before(oldestAt) {
				oldestKey, oldestAt = k, e.expireAt
			}
		}
		if oldestKey != "" {
			delete(c.entries, oldestKey)
		}
	}
	c.entries[key] = marketCacheEntry{body: body, expireAt: expireAt}
}
