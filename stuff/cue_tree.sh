# get the list of genre and countries
curl -s https://www.q-3.eu/sitemap.txt | grep '/country/\|/genre/' | awk -F '/' '{print $4"/"$5}' > tags.txt

# get all station ids for each categories
for i in $(cat tags.txt) ; do curl -s https://www.q-3.eu/$i | htmlq -a href a | grep '/station/' | awk -F '/' '{print $3}' > A-$(echo $i | awk -F '/' '{print $2}').txt ; echo $i ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.q-3.eu/station/$j > mep1 ; cat mep1 | htmlq -t h1 | head -n 1 | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' >> A$i ; cat mep1 | grep '<source src=' | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove duplicates
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# add m3u metadata
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# correct filenames
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
