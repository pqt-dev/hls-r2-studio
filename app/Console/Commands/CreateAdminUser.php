<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

class CreateAdminUser extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'admin:create {username} {password} {--email=}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Tạo hoặc cập nhật tài khoản admin (upsert theo username)';

    /**
     * Execute the console command.
     */
    public function handle(): void
    {
        $username = $this->argument('username');
        $password = $this->argument('password');

        User::updateOrCreate(
            ['username' => $username],
            ['name' => 'Admin', 'password' => $password, 'email' => $this->option('email')]
        );

        $this->info("Đã tạo/cập nhật admin: {$username}");
    }
}
