# get the list of genre and countries
curl -s https://nradiobox.com/sitemap-genres.xml | htmlq -t loc | cut -c29- > genres.txt
curl -s https://nradiobox.com/sitemap-countries.xml | htmlq -t loc | cut -c31- > countries.txt

# get all station ids for each categories
for i in "" \?page={2..25} ; do while IFS= read -r j ; do curl -s "https://nradiobox.com/country/$j$i" > mep1 ; name=$(./htmlq -t h1 < mep1) ; safe_name=$(printf '%s' "$name" | sed 's/[^[:alnum:]_.-]/_/g'); [ -n "$safe_name" ] || safe_name=$j ; ./htmlq -a href a < mep1 | grep station | grep '/station/' | cut -c10- >> A-$safe_name.txt ; echo "$j - $i" ; done < countries.txt ; done
for i in "" \?page={2..25} ; do for j in $(cat g.txt) ; do curl -s https://nradiobox.com/genre/$i$j | htmlq -a href a | grep station | grep '/station/' | cut -c10- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape everything
for i in A-*.txt ; do printf '#EXTM3U\n' > A$i ; for j in $(cat $i) ; do curl -s https://nradiobox.com/station/$j > mep1 ; t=$(htmlq -t h1 < mep1 | sed 's/^[[:space:]]*//') ; u=$(perl -0777 -MJSON::PP -ne 'if (/\burl_resolved:\s*("(?:\\.|[^"\\])*")/) { print JSON::PP::decode_json($1), "\n" }' mep1) ; [ -z "$u" ] && continue; printf '#EXTINF:-1,%s\n%s\n' "$t" "$u" >> A$i ; echo "$i - $j" ; done ; done

# remove duplicates
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# add m3u metadata
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# correct filenames
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
