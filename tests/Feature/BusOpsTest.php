<?php
namespace Tests\Feature;
use App\Models\{Absence,Customer,User};
use App\Models\BusTask;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class BusOpsTest extends TestCase {
    use RefreshDatabase;
    public function test_guest_sees_application():void { $this->get('/')->assertOk()->assertSee('BusOps'); }
    public function test_admin_and_customer_can_change_their_own_password():void {
        foreach(['admin','customer'] as $role){
            $user=User::factory()->create(['role'=>$role,'password'=>'gammel-kode']);
            $this->actingAs($user)->putJson('/api/password',['current_password'=>'gammel-kode','password'=>'ny-sikker-kode','password_confirmation'=>'ny-sikker-kode'])->assertOk();
            $this->assertTrue(Hash::check('ny-sikker-kode',$user->fresh()->password));
        }
    }
    public function test_password_change_requires_the_current_password():void {
        $admin=User::factory()->create(['role'=>'admin','password'=>'rigtig-kode']);
        $this->actingAs($admin)->putJson('/api/password',['current_password'=>'forkert-kode','password'=>'ny-sikker-kode','password_confirmation'=>'ny-sikker-kode'])->assertUnprocessable();
        $this->assertTrue(Hash::check('rigtig-kode',$admin->fresh()->password));
    }
    public function test_admin_can_create_task_and_business_rule_is_applied():void {
        $admin=User::factory()->create(['role'=>'admin']); $customer=Customer::create(['name'=>'Bus4You']);
        $this->actingAs($admin)->postJson('/api/tasks',['customer_id'=>$customer->id,'bus_number'=>'B-1','pickup_location'=>'Københavns Lufthavn','scheduled_at'=>now()->addHour()->toISOString()])
            ->assertCreated()->assertJson(['task_type'=>'passenger','requires_driving_license'=>true,'dropoff_location'=>'Københavns Busterminal']);
    }
    public function test_employee_cannot_create_task():void { $employee=User::factory()->create(['role'=>'employee']); $this->actingAs($employee)->postJson('/api/tasks',[])->assertForbidden(); }
    public function test_employee_dashboard_contains_only_their_own_absence_days():void {
        $fisnik=User::factory()->create(['name'=>'Fisnik','role'=>'employee']);$agron=User::factory()->create(['name'=>'Agron','role'=>'employee']);
        Absence::create(['user_id'=>$fisnik->id,'type'=>'day_off','starts_on'=>'2026-08-22','ends_on'=>'2026-08-22','reason'=>'Planlagt fri']);
        Absence::create(['user_id'=>$agron->id,'type'=>'day_off','starts_on'=>'2026-08-23','ends_on'=>'2026-08-23','reason'=>'Planlagt fri']);
        $this->actingAs($fisnik)->getJson('/api/dashboard')->assertOk()->assertJsonCount(1,'absences')->assertJsonPath('absences.0.user_id',$fisnik->id)->assertJsonPath('absences.0.type','day_off')->assertJsonPath('absences.0.starts_on','2026-08-22')->assertJsonMissing(['starts_on'=>'2026-08-23']);
        $this->actingAs($agron)->getJson('/api/dashboard')->assertOk()->assertJsonCount(1,'absences')->assertJsonPath('absences.0.user_id',$agron->id)->assertJsonPath('absences.0.type','day_off')->assertJsonPath('absences.0.starts_on','2026-08-23')->assertJsonMissing(['starts_on'=>'2026-08-22']);
    }
    public function test_admin_can_register_a_specific_employee_day_off():void {
        $admin=User::factory()->create(['role'=>'admin']);$employee=User::factory()->create(['role'=>'employee']);
        $this->actingAs($admin)->postJson('/api/absences',['user_id'=>$employee->id,'type'=>'day_off','starts_on'=>'2026-08-26','ends_on'=>'2026-08-26','reason'=>'Planlagt fri'])->assertCreated()->assertJson(['type'=>'day_off','reason'=>'Planlagt fri']);
        $this->assertDatabaseHas('absences',['user_id'=>$employee->id,'type'=>'day_off','starts_on'=>'2026-08-26']);
    }
    public function test_customer_can_create_task_for_own_company():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $this->actingAs($user)->postJson('/api/tasks',['customer_id'=>$company->id,'bus_number'=>'BY-20','pickup_location'=>'Busterminal','scheduled_at'=>now()->addHour()->toISOString()])
            ->assertCreated()->assertJson(['customer_id'=>$company->id,'dropoff_location'=>'Københavns Busterminal']);
    }
    public function test_employee_pickup_records_actual_time():void {
        $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$employee->id,'bus_number'=>'BY-30','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now()->addHour(),'status'=>'assigned']);
        $this->actingAs($employee)->postJson("/api/tasks/{$task->id}/status",['status'=>'delivered','actual_pickup_location'=>'Københavns Lufthavn'])->assertOk()->assertJson(['status'=>'delivered','actual_pickup_location'=>'Københavns Lufthavn']);
        $fresh=$task->fresh(); $this->assertNotNull($fresh->picked_up_at); $this->assertNotNull($fresh->delivered_at);
    }
    public function test_admin_cannot_set_actual_pickup_location():void {
        $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$employee->id,'bus_number'=>'BY-31','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now()->addHour(),'status'=>'assigned']);
        $this->actingAs($admin)->postJson("/api/tasks/{$task->id}/status",['status'=>'picked_up','actual_pickup_location'=>'Københavns Lufthavn'])->assertForbidden();
        $this->assertNull($task->fresh()->actual_pickup_location);
    }
    public function test_assigned_employee_can_change_actual_pickup_location_without_changing_status():void {
        $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$employee->id,'bus_number'=>'BY-32','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now()->addHour(),'status'=>'assigned']);
        $this->actingAs($employee)->patchJson("/api/tasks/{$task->id}/actual-pickup-location",['actual_pickup_location'=>'Københavns Lufthavn'])->assertOk()->assertJson(['status'=>'assigned','actual_pickup_location'=>'Københavns Lufthavn']);
        $this->assertSame('assigned',$task->fresh()->status);
    }
    public function test_customer_dashboard_hides_internal_notes():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$employee->id,'bus_number'=>'BY-40','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'delivered','notes'=>'Intern besked']);
        $this->actingAs($user)->getJson('/api/dashboard')->assertOk()->assertJsonMissing(['notes'=>'Intern besked']);
    }
    public function test_customer_can_edit_and_delete_own_unstarted_task():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$user->id,'bus_number'=>'FEJL','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now()->addDay(),'status'=>'unassigned']);
        $this->actingAs($user)->patchJson("/api/tasks/{$task->id}",['bus_number'=>'RETTET'])->assertOk()->assertJson(['bus_number'=>'RETTET']);
        $this->deleteJson("/api/tasks/{$task->id}")->assertNoContent(); $this->assertDatabaseMissing('bus_tasks',['id'=>$task->id]);
    }
    public function test_customer_can_only_replace_bus_number_even_after_pickup():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$user->id,'bus_number'=>'DEFEKT','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'picked_up']);
        $this->actingAs($user)->patchJson("/api/tasks/{$task->id}",['bus_number'=>'ERSTATNING','pickup_location'=>'Malmö Station'])->assertOk()->assertJson(['bus_number'=>'ERSTATNING']);
        $fresh=$task->fresh(); $this->assertSame('Busterminal',$fresh->pickup_location); $this->assertSame('picked_up',$fresh->status);
    }
    public function test_customer_can_change_arrival_time_before_pickup():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$user->id,'bus_number'=>'TID','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now()->addHour(),'status'=>'assigned']);
        $newTime=now()->addHours(3)->startOfMinute()->format('Y-m-d H:i:s');
        $this->actingAs($user)->patchJson("/api/tasks/{$task->id}",['scheduled_at'=>$newTime])->assertOk();
        $this->assertSame($newTime,$task->fresh()->scheduled_at->format('Y-m-d H:i:s'));
    }
    public function test_customer_cannot_change_arrival_time_after_pickup():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$user->id,'bus_number'=>'HENTET','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'picked_up']);
        $this->actingAs($user)->patchJson("/api/tasks/{$task->id}",['scheduled_at'=>now()->addHour()->toISOString()])->assertStatus(422);
    }
    public function test_customer_cannot_delete_completed_task():void {
        $user=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']); $company=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$user->id,'bus_number'=>'DONE','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'delivered']);
        $this->actingAs($user)->deleteJson("/api/tasks/{$task->id}")->assertStatus(422); $this->assertDatabaseHas('bus_tasks',['id'=>$task->id]);
    }
    public function test_admin_can_edit_and_delete_employee():void {
        $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee','name'=>'Gammelt navn']);
        $this->actingAs($admin)->patchJson("/api/employees/{$employee->id}",['name'=>'Nyt navn','email'=>'nyt@example.dk','phone'=>'12345678','password'=>''])->assertOk()->assertJson(['name'=>'Nyt navn','email'=>'nyt@example.dk']);
        $this->deleteJson("/api/employees/{$employee->id}")->assertNoContent();
        $this->assertDatabaseMissing('users',['id'=>$employee->id]);
    }
    public function test_admin_can_reset_customer_password():void {
        $admin=User::factory()->create(['role'=>'admin']);
        $customerUser=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk','password'=>'gammel-kode']);
        $customer=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $this->actingAs($admin)->patchJson("/api/customers/{$customer->id}/password",['password'=>'NySikkerKode123!','password_confirmation'=>'NySikkerKode123!'])->assertNoContent();
        $this->assertTrue(\Illuminate\Support\Facades\Hash::check('NySikkerKode123!',$customerUser->fresh()->password));
    }
    public function test_customer_cannot_reset_customer_password():void {
        $customerUser=User::factory()->create(['role'=>'customer','email'=>'kunde@bus4you.dk']);
        $customer=Customer::create(['name'=>'Bus4You','email'=>'kunde@bus4you.dk']);
        $this->actingAs($customerUser)->patchJson("/api/customers/{$customer->id}/password",['password'=>'NySikkerKode123!','password_confirmation'=>'NySikkerKode123!'])->assertForbidden();
    }
    public function test_admin_can_change_employee_on_assigned_task():void {
        $admin=User::factory()->create(['role'=>'admin']); $first=User::factory()->create(['role'=>'employee']); $second=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$first->id,'bus_number'=>'SKIFT','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now()->addHour(),'status'=>'assigned']);
        $this->actingAs($admin)->postJson("/api/tasks/{$task->id}/assign",['employee_id'=>$second->id])->assertOk()->assertJsonPath('employee.id',$second->id);
        $this->assertSame($second->id,$task->fresh()->employee_id);
    }
    public function test_employee_can_correct_bus_number_and_undo_an_accidental_pickup():void {
        $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$employee->id,'bus_number'=>'FORKERT','pickup_location'=>'Busterminal','actual_pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'delivered','picked_up_at'=>now(),'delivered_at'=>now()]);
        $this->actingAs($employee)->patchJson("/api/tasks/{$task->id}/employee-bus-number",['bus_number'=>'75191'])->assertOk()->assertJson(['bus_number'=>'75191']);
        $correctTime=now()->subMinutes(20)->startOfMinute();
        $this->patchJson("/api/tasks/{$task->id}/employee-pickup-time",['picked_up_at'=>$correctTime->toISOString()])->assertOk();
        $this->assertSame($correctTime->timestamp,$task->fresh()->picked_up_at->timestamp);
        $this->postJson("/api/tasks/{$task->id}/undo-pickup")->assertOk()->assertJson(['status'=>'assigned','actual_pickup_location'=>null]);
        $fresh=$task->fresh(); $this->assertNull($fresh->picked_up_at); $this->assertNull($fresh->delivered_at);
    }
    public function test_employee_cannot_correct_another_employees_task():void {
        $admin=User::factory()->create(['role'=>'admin']); $assigned=User::factory()->create(['role'=>'employee']); $other=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$assigned->id,'bus_number'=>'75191','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'delivered']);
        $this->actingAs($other)->patchJson("/api/tasks/{$task->id}/employee-bus-number",['bus_number'=>'75192'])->assertForbidden();
        $this->patchJson("/api/tasks/{$task->id}/employee-pickup-time",['picked_up_at'=>now()->subMinute()->toISOString()])->assertForbidden();
        $this->postJson("/api/tasks/{$task->id}/undo-pickup")->assertForbidden();
    }
    public function test_employee_cannot_set_pickup_registration_in_the_future():void {
        $admin=User::factory()->create(['role'=>'admin']); $employee=User::factory()->create(['role'=>'employee']); $company=Customer::create(['name'=>'Bus4You']);
        $task=BusTask::create(['customer_id'=>$company->id,'created_by'=>$admin->id,'employee_id'=>$employee->id,'bus_number'=>'75191','pickup_location'=>'Busterminal','dropoff_location'=>'Københavns Busterminal','scheduled_at'=>now(),'status'=>'delivered','picked_up_at'=>now(),'delivered_at'=>now()]);
        $this->actingAs($employee)->patchJson("/api/tasks/{$task->id}/employee-pickup-time",['picked_up_at'=>now()->addHour()->toISOString()])->assertUnprocessable();
    }
}
