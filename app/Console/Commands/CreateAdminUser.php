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
    protected $signature = 'admin:create {email} {password}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Tạo hoặc cập nhật tài khoản admin (upsert theo email)';

    /**
     * Execute the console command.
     */
    public function handle(): void
    {
        $email = $this->argument('email');
        $password = $this->argument('password');

        User::updateOrCreate(
            ['email' => $email],
            ['name' => 'Admin', 'password' => $password]
        );

        $this->info("Đã tạo/cập nhật admin: {$email}");
    }
}
