import React, { useState, useEffect } from 'react';
import { supabase } from '../hooks/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/Card';
import { Button } from './ui/Button';
import { toast } from './ui/Toaster';
import { Activity, Clock, ShieldCheck, ShieldAlert } from 'lucide-react';
import { differenceInDays, parseISO, format } from 'date-fns';

const HealthMonitor: React.FC = () => {
    const [lastInvoiceDate, setLastInvoiceDate] = useState<Date | null>(null);
    const [daysSinceInvoice, setDaysSinceInvoice] = useState<number | null>(null);
    const [lastPingDate, setLastPingDate] = useState<Date | null>(null);
    const [isPinging, setIsPinging] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    const PING_CUSTOMER_NAME = '__SYSTEM_PING__';
    const PING_CUSTOMER_EMAIL = 'system@ping.local';

    const fetchHealthData = async () => {
        setIsLoading(true);
        try {
            // Fetch last invoice
            const { data: invoiceData, error: invoiceError } = await supabase
                .from('invoices')
                .select('created_at')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (invoiceData && invoiceData.created_at) {
                const date = parseISO(invoiceData.created_at);
                setLastInvoiceDate(date);
                setDaysSinceInvoice(differenceInDays(new Date(), date));
            }

            // Fetch last ping
            const { data: pingData, error: pingError } = await supabase
                .from('customers')
                .select('updated_at, created_at, billing_address')
                .eq('name', PING_CUSTOMER_NAME)
                .single();

            if (pingData) {
                // We use billing_address to store the exact ISO date of the last ping
                if (pingData.billing_address) {
                   setLastPingDate(parseISO(pingData.billing_address));
                } else if (pingData.updated_at) {
                   setLastPingDate(parseISO(pingData.updated_at));
                } else {
                   setLastPingDate(parseISO(pingData.created_at));
                }
            } else {
                // Try from local storage as fallback
                const localPing = localStorage.getItem('lastSystemPing');
                if (localPing) {
                    setLastPingDate(parseISO(localPing));
                }
            }
        } catch (error) {
            console.error("Error fetching health data:", error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchHealthData();
    }, []);

    const handlePing = async () => {
        setIsPinging(true);
        try {
            const now = new Date().toISOString();
            
            // Check if ping customer exists
            const { data: existing } = await supabase
                .from('customers')
                .select('id')
                .eq('name', PING_CUSTOMER_NAME)
                .single();
            
            if (existing) {
                // Update
                await supabase
                    .from('customers')
                    .update({ billing_address: now })
                    .eq('id', existing.id);
            } else {
                // Insert
                await supabase
                    .from('customers')
                    .insert({
                        name: PING_CUSTOMER_NAME,
                        email: PING_CUSTOMER_EMAIL,
                        phone: 'PING',
                        is_guest: true,
                        billing_address: now
                    });
            }

            localStorage.setItem('lastSystemPing', now);
            setLastPingDate(parseISO(now));
            toast('Database pinged successfully! Timer reset.');
        } catch (error: any) {
            toast(`Failed to ping database: ${error.message}`);
        } finally {
            setIsPinging(false);
        }
    };

    const getStatusColor = (days: number | null) => {
        if (days === null) return "text-gray-500";
        if (days >= 7) return "text-red-500";
        if (days >= 5) return "text-amber-500";
        return "text-green-500";
    };

    const getStatusIcon = (days: number | null) => {
        if (days === null) return <Activity className="w-5 h-5 text-gray-500" />;
        if (days >= 7) return <ShieldAlert className="w-5 h-5 text-red-500" />;
        if (days >= 5) return <ShieldAlert className="w-5 h-5 text-amber-500" />;
        return <ShieldCheck className="w-5 h-5 text-green-500" />;
    };

    // Database pauses if NO activity for 7 days.
    // If they pinged recently, it's safe.
    const daysSincePing = lastPingDate ? differenceInDays(new Date(), lastPingDate) : null;
    const effectiveDaysInactive = Math.min(
        daysSinceInvoice ?? 999, 
        daysSincePing ?? 999
    );
    
    // Fallback if both are null
    const displayDays = effectiveDaysInactive === 999 ? null : effectiveDaysInactive;

    return (
        <Card className="hover:shadow-md transition-shadow border-l-4 border-l-blue-500">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center text-sm font-medium">
                    <Activity className="w-4 h-4 mr-2 text-blue-500" />
                    Database Health Monitor
                </CardTitle>
                <CardDescription>Prevents Supabase from pausing (7-day limit)</CardDescription>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="animate-pulse space-y-2">
                        <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                        <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="flex items-start justify-between">
                            <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                    {getStatusIcon(displayDays)}
                                    <span className={`font-semibold ${getStatusColor(displayDays)}`}>
                                        {displayDays === null 
                                            ? "Unknown status" 
                                            : displayDays === 0 
                                                ? "Active today" 
                                                : `${displayDays} ${displayDays === 1 ? 'day' : 'days'} inactive`}
                                    </span>
                                </div>
                                <div className="text-xs text-muted-foreground flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    Last Invoice: {lastInvoiceDate ? format(lastInvoiceDate, 'PPp') : 'Never'}
                                </div>
                                {lastPingDate && (
                                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                                        <Activity className="w-3 h-3" />
                                        Last Ping: {format(lastPingDate, 'PPp')}
                                    </div>
                                )}
                            </div>
                        </div>
                        <Button 
                            variant={displayDays !== null && displayDays >= 5 ? "default" : "outline"} 
                            size="sm" 
                            className="w-full" 
                            onClick={handlePing}
                            disabled={isPinging}
                        >
                            {isPinging ? 'Pinging...' : 'Send Database Ping'}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default HealthMonitor;
