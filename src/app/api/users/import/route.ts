// app/api/users/import/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';
import { db } from '@/lib/db/db';

// Helper function to verify authentication
async function verifyAuth() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get('token');

        if (!token) {
            return { error: 'No token found', status: 401 };
        }

        const { payload } = await jwtVerify(
            token.value,
            new TextEncoder().encode(process.env.JWT_SECRET)
        );

        const userId = Number(payload.id);
        const role = payload.role as string;
        const name = payload.name as string;

        // Verify user is still active
        const user = await db.users.findUnique({
            where: { id: userId },
            select: { id: true, name: true, role: true, department: true, is_active: true }
        });

        if (!user || !user.is_active) {
            return { error: 'User not found or inactive', status: 401 };
        }

        return { user: { ...user, id: userId, role, name } };
    } catch (error) {
        return { error: 'Invalid token', status: 401 };
    }
}

// POST /api/users/import - Bulk import users from Excel (Admin only)
export async function POST(request: NextRequest) {
    try {
        const authResult = await verifyAuth();
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status });
        }

        if (!authResult.user) {
            return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
        }

        const { user } = authResult;

        // Check if user is admin
        if (user.role !== 'admin') {
            return NextResponse.json(
                { error: 'Unauthorized. Admin access required.' },
                { status: 403 }
            );
        }

        const body = await request.json();
        const { users } = body;

        if (!users || !Array.isArray(users)) {
            return NextResponse.json(
                { error: 'Invalid data format. Expected array of users.' },
                { status: 400 }
            );
        }

        const results = {
            imported: 0,
            skipped: 0,
            errors: [] as string[],
            duplicates: [] as string[]
        };

        // Get existing id_numbers and emails to avoid duplicates
        const existingUsers = await db.users.findMany({
            select: { id_number: true, email: true, name: true }
        });
        const existingIdNumbers = new Map(existingUsers.map(u => [u.id_number, u.name]));
        const existingEmails = new Map(
            existingUsers
                .filter(u => u.email)
                .map(u => [u.email!.toLowerCase(), u.name])
        );

        // Track duplicates within the current batch
        const batchIdNumbers = new Set<string>();
        const batchEmails = new Set<string>();

        // Process each user
        for (let i = 0; i < users.length; i++) {
            const userData = users[i];
            const rowNumber = i + 2; // +2 because Excel rows start at 1 and we have a header row

            try {
                // Validation - required fields
                if (!userData.name || !userData.id_number || !userData.role || 
                    !userData.phone_number || !userData.gender) {
                    results.errors.push(
                        `Row ${rowNumber}: Missing required fields (name, id_number, role, phone_number, gender)`
                    );
                    results.skipped++;
                    continue;
                }

                const upperIdNumber = userData.id_number.toString().toUpperCase().trim();
                const lowerEmail = userData.email ? userData.email.toLowerCase().trim() : null;

                // Check for duplicate ID numbers in existing database
                if (existingIdNumbers.has(upperIdNumber)) {
                    const existingUserName = existingIdNumbers.get(upperIdNumber);
                    results.duplicates.push(
                        `Row ${rowNumber}: ID number '${upperIdNumber}' already exists (User: ${existingUserName})`
                    );
                    results.skipped++;
                    continue;
                }

                // Check for duplicate ID numbers within current batch
                if (batchIdNumbers.has(upperIdNumber)) {
                    results.duplicates.push(
                        `Row ${rowNumber}: Duplicate ID number '${upperIdNumber}' found in import file`
                    );
                    results.skipped++;
                    continue;
                }

                // Check for duplicate emails in existing database (if provided)
                if (lowerEmail && existingEmails.has(lowerEmail)) {
                    const existingUserName = existingEmails.get(lowerEmail);
                    results.duplicates.push(
                        `Row ${rowNumber}: Email '${lowerEmail}' already exists (User: ${existingUserName})`
                    );
                    results.skipped++;
                    continue;
                }

                // Check for duplicate emails within current batch
                if (lowerEmail && batchEmails.has(lowerEmail)) {
                    results.duplicates.push(
                        `Row ${rowNumber}: Duplicate email '${lowerEmail}' found in import file`
                    );
                    results.skipped++;
                    continue;
                }

                // Validate role
                const validRoles = ['admin', 'employee'];
                if (!validRoles.includes(userData.role.toLowerCase())) {
                    results.errors.push(
                        `Row ${rowNumber}: Invalid role '${userData.role}'. Must be one of: ${validRoles.join(', ')}`
                    );
                    results.skipped++;
                    continue;
                }

                // Validate gender
                const validGenders = ['male', 'female'];
                if (!validGenders.includes(userData.gender.toLowerCase())) {
                    results.errors.push(
                        `Row ${rowNumber}: Invalid gender '${userData.gender}'. Must be 'male' or 'female'`
                    );
                    results.skipped++;
                    continue;
                }

                // Truncate department to 20 characters (database limit)
                let department = null;
                if (userData.department) {
                    const deptString = userData.department.toString().trim();
                    if (deptString.length > 20) {
                        department = deptString.substring(0, 20);
                        results.errors.push(
                            `Row ${rowNumber}: Department name truncated to 20 characters (was: "${deptString}")`
                        );
                    } else {
                        department = deptString;
                    }
                }

                // Add to batch tracking sets
                batchIdNumbers.add(upperIdNumber);
                if (lowerEmail) {
                    batchEmails.add(lowerEmail);
                }

                // Create user
                await db.users.create({
                    data: {
                        name: userData.name.trim(),
                        id_number: upperIdNumber,
                        role: userData.role.toLowerCase(),
                        phone_number: userData.phone_number.trim(),
                        department: department,
                        gender: userData.gender.toLowerCase(),
                        email: lowerEmail,
                        is_active: userData.is_active !== false,
                        created_by: user.name
                    }
                });

                // Add to existing maps for next iterations
                existingIdNumbers.set(upperIdNumber, userData.name);
                if (lowerEmail) {
                    existingEmails.set(lowerEmail, userData.name);
                }

                results.imported++;
            } catch (error) {
                console.error(`Error importing user at row ${rowNumber}:`, error);
                results.errors.push(
                    `Row ${rowNumber}: Failed to create user '${userData.name}' - ${error instanceof Error ? error.message : 'Unknown error'}`
                );
                results.skipped++;
            }
        }

        // Return results with appropriate status
        return NextResponse.json({
            success: results.imported > 0,
            message: results.imported > 0 
                ? `Successfully imported ${results.imported} user(s)` 
                : 'No users were imported',
            imported: results.imported,
            skipped: results.skipped,
            errors: results.errors,
            duplicates: results.duplicates
        });

    } catch (error) {
        console.error('Error importing users:', error);
        return NextResponse.json(
            { 
                success: false,
                error: 'Failed to import users',
                details: error instanceof Error ? error.message : 'Unknown error'
            },
            { status: 500 }
        );
    }
}