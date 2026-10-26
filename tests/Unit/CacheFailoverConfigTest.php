<?php

namespace Tests\Unit;

use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\Repository;
use Illuminate\Support\Facades\Cache;
use RuntimeException;
use Tests\TestCase;

class CacheFailoverConfigTest extends TestCase
{
    public function test_failover_store_tries_redis_then_database_then_array(): void
    {
        $this->assertSame(['redis', 'database', 'array'], config('cache.stores.failover.stores'));
    }

    public function test_redis_and_database_stores_are_still_defined(): void
    {
        $this->assertArrayHasKey('redis', config('cache.stores'));
        $this->assertArrayHasKey('database', config('cache.stores'));
    }

    public function test_failover_falls_back_when_the_first_store_throws(): void
    {
        Cache::extend('broken', fn () => new Repository(new class extends ArrayStore
        {
            public function get($key)
            {
                throw new RuntimeException('down');
            }

            public function put($key, $value, $seconds)
            {
                throw new RuntimeException('down');
            }

            public function add($key, $value, $seconds)
            {
                throw new RuntimeException('down');
            }

            public function increment($key, $value = 1)
            {
                throw new RuntimeException('down');
            }
        }));

        config([
            'cache.stores.broken' => ['driver' => 'broken'],
            'cache.stores.fallback_test' => ['driver' => 'failover', 'stores' => ['broken', 'array']],
        ]);

        $cache = Cache::store('fallback_test');

        $this->assertTrue($cache->add('hits', 0, 60));
        $this->assertSame(1, $cache->increment('hits'));
        $this->assertSame(2, $cache->increment('hits'));
        $this->assertSame(2, $cache->get('hits'));
    }
}
